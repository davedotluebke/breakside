/*
 * Narration clip recorder — opt-in, device-local capture of what a
 * narration session heard and produced, so misheard clips can be replayed
 * through the test harness (breakside_server/tests/narration/).
 *
 * Privacy contract (privacy.html § Voice narration):
 *   - Off by default. Turning it on (Advanced Settings › "Keep narration
 *     clips on this device") shows its own disclosure; the toggle only
 *     sticks once that is accepted.
 *   - Audio has no server path. Clips live in this browser's IndexedDB
 *     (clipStore.js) and leave the device only through the coach's own
 *     Export action (share sheet or download). There is no upload.
 *   - Bounded: retention trims clips older than 30 days or beyond 200 MB.
 *
 * Capture taps realtimeSession's outgoing PCM16 chunks — the exact bytes
 * streamed to OpenAI, so a replay in the harness is byte-identical — via
 * setAudioTap(). Session context (roster, and for the in-game surfaces the
 * on-field line and game context) is read at session start; the transcript
 * arrives at session stop; the model's result is attached afterwards from
 * the event bus (narrationFinalized / lineupResolved / squadsResolved).
 * Each clip exports as a scenario bundle (clipBundle.js) needing only a
 * hand-checked expected.json.
 */
import { narrationRealtimeSession } from './realtimeSession.js';
import { narrationEventBus } from './eventBus.js';
import { narrationEngine } from './narrationEngine.js';
import { lineupNarration } from './lineupNarration.js';
import { squadNarration } from './squadNarration.js';
import { advancedSettings } from '../settings/advancedSettings.js';
import { getActiveRoster } from '../store/storage.js';
import { currentGame } from '../utils/helpers.js';
import { showControllerToast } from '../game/controllerState.js';
import { log } from '../utils/logger.js';
import * as clipStore from './clipStore.js';
import {
    pcmDurationMs, zipStore, buildClipBundle, clipBundleStem,
    formatDuration, formatBytes
} from './clipBundle.js';

const narrationClipRecorder = (function() {
    const SETTING_KEY = 'narration.recordClips';
    const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
    const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    // Shorter than this is a mis-tap, not a narration.
    const MIN_CLIP_MS = 500;
    const RESULT_KINDS = { finalize: 'events', lineup: 'lineup', squads: 'squads' };
    // The surfaces that narrate inside a game; only their clips carry game context.
    const GAME_KINDS = ['events', 'lineup'];
    // Set the first time this browser saves a clip. Until then nothing here
    // opens IndexedDB, so a device that never opted in has no clip database.
    const USED_KEY = 'breakside_narration_clips_used';

    function markUsed() {
        try { localStorage.setItem(USED_KEY, '1'); } catch (_) { /* storage blocked */ }
    }

    function everUsed() {
        try { return localStorage.getItem(USED_KEY) === '1'; } catch (_) { return false; }
    }

    /** Saved clips, newest first; an empty list (database untouched) before the first save. */
    function listSavedClips() {
        return everUsed() ? clipStore.listClips() : Promise.resolve([]);
    }

    // The session being captured, or null. Chunks are the Int16Arrays
    // realtimeSession built for the wire; it never reuses them, so we keep
    // them as-is and let the Blob constructor copy once at the end.
    let active = null;
    // Promise for the most recent save, so a result that arrives while the
    // IndexedDB write is still in flight attaches to the right clip.
    let lastSave = null;

    function toast(message, type = 'info', duration) {
        if (typeof showControllerToast === 'function') {
            showControllerToast(message, type, duration);
        } else {
            console.warn(`[clipRecorder] (no toast) ${type}: ${message}`);
        }
    }

    function isEnabled() {
        try { return !!advancedSettings.get(SETTING_KEY); } catch (_) { return false; }
    }

    // -----------------------------------------------------------------
    // Session context
    // -----------------------------------------------------------------

    // Which narration surface owns this session. Each sets its phase to
    // 'connecting' before calling realtimeSession.start(), so the phase
    // tells us without any of them having to know the recorder exists.
    function inferKind() {
        const live = (surface) => {
            const phase = surface && surface.getPhase ? surface.getPhase() : 'idle';
            return phase === 'connecting' || phase === 'recording';
        };
        if (live(narrationEngine)) return 'events';
        if (live(lineupNarration)) return 'lineup';
        if (live(squadNarration)) return 'squads';
        return 'unknown';
    }

    // Which build heard this (main.js sets these from version.json at boot).
    function appInfo() {
        return {
            version: window.APP_VERSION || null,
            build: window.APP_BUILD || null,
            deployLabel: window.APP_DEPLOY_LABEL || null
        };
    }

    function snapshotContext(kind) {
        const ctx = { roster: [], onField: [], gameId: null, gameContext: null };
        try {
            const roster = typeof getActiveRoster === 'function' ? getActiveRoster() : [];
            ctx.roster = (roster || []).map(p => ({
                name: p.name,
                nickname: p.nickname || null,
                number: p.number != null && p.number !== '' ? String(p.number) : null
            }));
        } catch (err) {
            log('[clipRecorder] roster snapshot failed:', err);
        }
        // Game context only for the surfaces that narrate inside a game. The
        // squad picker opens from the team screen, where currentGame() is
        // whichever game was open last: its score and line are not this
        // session's. (What the squads pass was given arrives with its result.)
        if (!GAME_KINDS.includes(kind)) return ctx;
        try {
            const game = typeof currentGame === 'function' ? currentGame() : null;
            if (game) {
                ctx.gameId = game.id || null;
                const pt = game.points && game.points.length ? game.points[game.points.length - 1] : null;
                ctx.onField = pt && Array.isArray(pt.players) ? pt.players.slice() : [];
                // Same shape the slow pass receives (narrationEngine.runSlowPass).
                ctx.gameContext = {
                    offense: pt ? pt.startingPosition === 'offense' : true,
                    our_score: game.scores ? game.scores.team : 0,
                    their_score: game.scores ? game.scores.opponent : 0,
                    point: game.points ? game.points.length : 0
                };
            }
        } catch (err) {
            log('[clipRecorder] game snapshot failed:', err);
        }
        return ctx;
    }

    // -----------------------------------------------------------------
    // Audio tap (realtimeSession lifecycle)
    // -----------------------------------------------------------------

    function onSessionStart(info) {
        active = null;
        if (!isEnabled()) return;
        const kind = inferKind();
        active = {
            kind,
            mode: info.mode,
            transcriptionModel: info.transcriptionModel || null,
            sampleRate: info.sampleRate || 24000,
            startedAt: Date.now(),
            app: appInfo(),
            chunks: [],
            samples: 0,
            ...snapshotContext(kind)
        };
        log(`[clipRecorder] capturing ${active.kind} session`);
    }

    function onAudioChunk(pcm16) {
        if (!active) return;
        active.chunks.push(pcm16);
        active.samples += pcm16.length;
    }

    function onSessionStop({ transcript = '', aborted = false } = {}) {
        const a = active;
        active = null;
        if (!a) return;
        const bytes = a.samples * 2;
        const durationMs = pcmDurationMs(bytes, a.sampleRate);
        if (durationMs < MIN_CLIP_MS) {
            log(`[clipRecorder] discarding ${durationMs}ms clip`);
            return;
        }
        const clip = {
            id: `clip-${a.startedAt}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: new Date(a.startedAt).toISOString(),
            kind: a.kind,
            mode: a.mode,
            transcriptionModel: a.transcriptionModel,
            sampleRate: a.sampleRate,
            durationMs,
            bytes,
            transcript: transcript || '',
            aborted: !!aborted,
            roster: a.roster,
            onField: a.onField,
            gameId: a.gameId,
            gameContext: a.gameContext,
            app: a.app,
            result: null,
            exportedAt: null,
            pcm: new Blob(a.chunks, { type: 'audio/pcm' })
        };
        markUsed();
        lastSave = clipStore.putClip(clip)
            .then(async (id) => {
                await clipStore.enforceRetention({ maxBytes: MAX_TOTAL_BYTES, maxAgeMs: MAX_AGE_MS });
                const waiting = (await clipStore.listClips()).filter(c => !c.exportedAt).length;
                toast(`Narration clip saved (${formatDuration(durationMs)}) — ${waiting} waiting to export in Advanced Settings`, 'info', 6000);
                return id;
            })
            .catch((err) => {
                console.warn('[clipRecorder] save failed:', err);
                toast('Narration clip not saved — browser storage unavailable', 'warning');
                return null;
            });
    }

    // The model's answer lands after the session is over; attach it to the
    // clip that was just saved so the export carries a draft expected.json.
    function attachResult(type, result) {
        const save = lastSave;
        if (!save) return;
        save.then(async (id) => {
            if (!id) return;
            const clip = await clipStore.getClip(id);
            if (!clip || clip.result) return;
            if (clip.kind !== 'unknown' && clip.kind !== RESULT_KINDS[type]) return;
            const patch = { result: { type, ...result } };
            // The squads pass names its own pool (the picker's players, with
            // who is here); that, not the team roster read at the start, is
            // the roster this clip was heard against.
            const pool = type === 'squads' && result.request && result.request.roster;
            if (Array.isArray(pool) && pool.length) {
                patch.roster = pool.map(p => ({
                    name: p.name, nickname: p.nickname || null, number: p.number != null ? String(p.number) : null
                }));
            }
            await clipStore.updateClip(id, patch);
        }).catch(err => console.warn('[clipRecorder] result attach failed:', err));
    }

    // -----------------------------------------------------------------
    // Opt-in disclosure
    // -----------------------------------------------------------------

    /**
     * Show the keep-clips disclosure. Resolves true only if the coach
     * accepts; advancedSettings persists the toggle on that answer.
     */
    function confirmOptIn() {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'modal';
            modal.style.display = 'flex';
            modal.innerHTML = `
                <div class="modal-content narration-disclosure-modal">
                    <div class="narration-disclosure-icon">💾</div>
                    <h3>Keep narration clips on this device?</h3>
                    <div class="narration-disclosure-body">
                        <p>
                            When this is on, each time you narrate, Breakside saves a copy of the
                            audio, the transcript, and what the app made of it — in this browser's
                            storage, on this device only.
                        </p>
                        <p>
                            <strong>Nothing is uploaded.</strong> A clip leaves this device only if
                            you export it yourself from Advanced Settings › Saved clips. Clips are
                            trimmed automatically after 30 days or 200 MB, and you can delete them
                            at any time.
                        </p>
                        <p>
                            Because clips are kept rather than just streamed, anyone near the
                            microphone stays recorded until you delete them. Don't keep recordings
                            where people would object.
                        </p>
                    </div>
                    <p class="narration-disclosure-more">
                        <a href="/privacy.html#narration" target="_blank" rel="noopener">Learn more</a>
                    </p>
                    <div class="modal-buttons">
                        <button type="button" class="secondary-btn" data-answer="no">Cancel</button>
                        <button type="button" class="primary-btn" data-answer="yes">Keep clips</button>
                    </div>
                </div>`;
            const finish = (answer) => { modal.remove(); resolve(answer); };
            modal.querySelectorAll('[data-answer]').forEach(btn => {
                btn.addEventListener('click', () => finish(btn.getAttribute('data-answer') === 'yes'));
            });
            modal.addEventListener('click', (e) => { if (e.target === modal) finish(false); });
            document.body.appendChild(modal);
        });
    }

    // -----------------------------------------------------------------
    // Export
    // -----------------------------------------------------------------

    async function deliverFile(bytes, name) {
        const file = new File([bytes], name, { type: 'application/zip' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({ files: [file], title: name });
                return 'shared';
            } catch (err) {
                if (err && err.name === 'AbortError') return 'cancelled';
                log('[clipRecorder] share failed, falling back to download:', err);
            }
        }
        const url = URL.createObjectURL(file);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return 'downloaded';
    }

    async function bundleEntries(clip, prefix = '') {
        const pcm = new Uint8Array(await clip.pcm.arrayBuffer());
        return buildClipBundle(clip, pcm).map(e => ({ name: prefix + e.name, data: e.data }));
    }

    async function exportClip(id) {
        const clip = await clipStore.getClip(id);
        if (!clip) return 'missing';
        const zip = zipStore(await bundleEntries(clip), new Date(clip.createdAt));
        const outcome = await deliverFile(zip, `${clipBundleStem(clip)}.zip`);
        if (outcome !== 'cancelled') {
            await clipStore.updateClip(id, { exportedAt: new Date().toISOString() });
        }
        return outcome;
    }

    /** One archive, one folder per clip — the scenarios/ layout the harness reads. */
    async function exportAll() {
        const clips = await listSavedClips();
        if (!clips.length) return 'empty';
        const entries = [];
        for (const clip of clips) {
            entries.push(...await bundleEntries(clip, `${clipBundleStem(clip)}/`));
        }
        const stamp = new Date().toISOString().slice(0, 10);
        const outcome = await deliverFile(zipStore(entries), `breakside-clips-${stamp}.zip`);
        if (outcome !== 'cancelled') {
            const exportedAt = new Date().toISOString();
            for (const clip of clips) await clipStore.updateClip(clip.id, { exportedAt });
        }
        return outcome;
    }

    // -----------------------------------------------------------------
    // Manage-clips modal
    // -----------------------------------------------------------------

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function kindLabel(kind) {
        return kind === 'lineup' ? 'Lineup' : kind === 'events' ? 'Play-by-play' : kind === 'squads' ? 'Squads' : 'Narration';
    }

    function renderRows(clips) {
        if (!clips.length) {
            return '<p class="clip-manager-empty">No clips saved yet. With the setting on, each narration you finish is saved here.</p>';
        }
        return clips.map(c => {
            const when = new Date(c.createdAt);
            const snippet = (c.transcript || '').trim() || '(no speech transcribed)';
            const flags = [
                c.exportedAt ? 'exported' : 'not exported',
                c.result ? 'with result' : 'no result',
                c.aborted ? 'session cut off' : null
            ].filter(Boolean).join(' · ');
            return `
                <li class="clip-row" data-id="${escapeHtml(c.id)}">
                    <div class="clip-row-main">
                        <div class="clip-row-title">${kindLabel(c.kind)} · ${formatDuration(c.durationMs)} · ${formatBytes(c.bytes)}</div>
                        <div class="clip-row-when">${escapeHtml(when.toLocaleString())} — ${flags}</div>
                        <div class="clip-row-snippet">${escapeHtml(snippet)}</div>
                    </div>
                    <div class="clip-row-actions">
                        <button type="button" class="clip-row-btn" data-act="export">Export</button>
                        <button type="button" class="clip-row-btn clip-row-btn-danger" data-act="delete">Delete</button>
                    </div>
                </li>`;
        }).join('');
    }

    async function showClips() {
        let modal = document.getElementById('narrationClipManagerModal');
        if (modal) modal.remove();
        modal = document.createElement('div');
        modal.id = 'narrationClipManagerModal';
        modal.className = 'modal';
        modal.style.display = 'flex';
        modal.innerHTML = `
            <div class="modal-content clip-manager-modal">
                <div class="dialog-header prominent-dialog-header">
                    <h2>Saved narration clips</h2>
                    <span class="close">&times;</span>
                </div>
                <p class="clip-manager-note">
                    Clips stay in this browser until you delete them (or after 30 days / 200 MB).
                    Export bundles the audio, transcript, roster and the app's result as a
                    scenario folder. ${isEnabled() ? 'Recording is <strong>on</strong> for new narrations.' : 'Recording is <strong>off</strong>; existing clips are kept.'}
                </p>
                <ul class="clip-manager-list"></ul>
                <div class="clip-manager-footer">
                    <span class="clip-manager-total"></span>
                    <button type="button" class="clip-row-btn" data-act="export-all">Export all</button>
                    <button type="button" class="clip-row-btn clip-row-btn-danger" data-act="delete-all">Delete all</button>
                    <button type="button" class="adv-done-btn" data-act="done">Done</button>
                </div>
            </div>`;
        document.body.appendChild(modal);
        const list = modal.querySelector('.clip-manager-list');
        const total = modal.querySelector('.clip-manager-total');

        const refresh = async () => {
            let clips = [];
            try {
                clips = await listSavedClips();
            } catch (err) {
                list.innerHTML = '<p class="clip-manager-empty">Browser storage is unavailable here (private browsing?), so no clips can be kept.</p>';
                total.textContent = '';
                return;
            }
            list.innerHTML = renderRows(clips);
            const bytes = clips.reduce((n, c) => n + (c.bytes || 0), 0);
            total.textContent = clips.length ? `${clips.length} clip${clips.length === 1 ? '' : 's'}, ${formatBytes(bytes)}` : '';
        };

        modal.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) {
                if (e.target === modal) modal.remove();
                return;
            }
            const act = btn.getAttribute('data-act');
            const row = btn.closest('.clip-row');
            const id = row ? row.getAttribute('data-id') : null;
            btn.disabled = true;
            try {
                if (act === 'done') {
                    modal.remove();
                } else if (act === 'export' && id) {
                    const outcome = await exportClip(id);
                    if (outcome === 'downloaded') toast('Clip downloaded', 'success');
                } else if (act === 'delete' && id) {
                    await clipStore.deleteClip(id);
                } else if (act === 'export-all') {
                    const outcome = await exportAll();
                    if (outcome === 'empty') toast('No clips to export', 'info');
                    else if (outcome === 'downloaded') toast('Clips downloaded', 'success');
                } else if (act === 'delete-all') {
                    if (everUsed() && window.confirm('Delete all saved narration clips on this device?')) {
                        await clipStore.clearClips();
                    }
                }
            } catch (err) {
                console.error('[clipRecorder] action failed:', err);
                toast('That didn’t work — see the console', 'error');
            } finally {
                btn.disabled = false;
            }
            if (document.body.contains(modal)) await refresh();
        });
        modal.querySelector('.close').onclick = () => modal.remove();
        await refresh();
    }

    // -----------------------------------------------------------------
    // Wiring
    // -----------------------------------------------------------------

    narrationRealtimeSession.setAudioTap({ onSessionStart, onAudioChunk, onSessionStop });

    narrationEventBus.subscribe('narrationFinalized', (p) => {
        attachResult('finalize', { operations: p.operations || [], error: p.error || null });
    });
    narrationEventBus.subscribe('lineupResolved', (p) => {
        attachResult('lineup', { request: p.request || null, response: p.response || null });
    });
    narrationEventBus.subscribe('squadsResolved', (p) => {
        attachResult('squads', { request: p.request || null, response: p.response || null });
    });

    // Startup trim, so a device that stopped being used still bounds itself
    // (the 30-day promise holds with the setting turned back off). Only on a
    // device that has saved a clip: everyone else never touches IndexedDB.
    if (everUsed()) {
        clipStore.enforceRetention({ maxBytes: MAX_TOTAL_BYTES, maxAgeMs: MAX_AGE_MS })
            .catch(() => { /* storage unavailable: nothing to trim */ });
    }

    return {
        confirmOptIn,
        showClips,
        exportClip,
        exportAll,
        isCapturing: () => !!active,
        listClips: listSavedClips,
        // Debug seam (console / Playwright): drive a capture without a mic
        // or an OpenAI session, e.g. _tap.onSessionStart({mode:'transcription',
        // sampleRate:24000}); _tap.onAudioChunk(new Int16Array(24000));
        // _tap.onSessionStop({transcript:'Alice to Bob'}).
        _tap: { onSessionStart, onAudioChunk, onSessionStop }
    };
})();

// --- ES-module export ---
export { narrationClipRecorder };
// window survivor: settings/advancedSettings.js reaches the disclosure and
// the manage-clips modal window-qualified (the settings layer can't import
// a narration module above it); devtools use it to inspect clips.
window.narrationClipRecorder = narrationClipRecorder;
