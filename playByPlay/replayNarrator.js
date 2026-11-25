/*
 * Replay Narrator — speaks the replay with the browser's own voice (Web
 * Speech API), the first subscriber to replayController's 'entry' hook
 * (docs/replay-viewer-plan.md § 9, Decision 12).
 *
 * Three pure pieces and one mount:
 *
 *   phraseEntry(entry, ctx)   One GameLogEntry → the sentence to say, or ''
 *                             for silence. Rephrases from the event's own
 *                             flags (a block is "Block by Bob!", a reset is
 *                             "Bob dumps it to Cara"), skips the log's
 *                             furniture (possession delimiters, headers), and
 *                             turns "Current score: Us 3, Them 2" into
 *                             "Us lead, 3 to 2."
 *   wantsEntry(entry, level)  The detail setting: 'pbp' (everything),
 *                             'events' (lineups, scores, timeouts / injury
 *                             subs / halftime), 'score' (score lines only).
 *   resolveVoice(synth, key)  The voice setting: 'male' (Daniel, en-GB),
 *                             'female' (Samantha, en-US) or 'robot' (Zarvox)
 *                             — Apple's names, with fallbacks by name, then
 *                             by language, for devices without them; the
 *                             robot falls back to a low-pitched read. An
 *                             exact voice name is accepted too.
 *   mountReplayNarrator(cfg)  DOM + speechSynthesis. Adds the 🔊 toggle and,
 *                             while narration is on, a ⚙ that opens a small
 *                             menu with those two settings; speaks each
 *                             entry as it plays, and in Speedy mode returns
 *                             a promise so the controller waits for the
 *                             sentence (it caps the wait, so a stuck voice
 *                             never freezes replay).
 *
 * Queue policy (the live viewer's problem): a sync can land several entries
 * at once and a phone voice takes 2–5 s per line, so the narrator keeps its
 * own queue rather than speechSynthesis's. At 2× / 4× only the newest line
 * survives (the voice can't keep up, and the field already moved on). At 1×
 * and Live the queue holds a few lines; past that, score lines are kept and
 * intermediate plays are dropped, newest first in — so the voice never trails
 * the field by half a minute after a reconnect. Any seek, step back, pause
 * or tab change cancels what is speaking.
 *
 * Why the browser voice: zero backend, zero per-game cost, works offline,
 * reaches share-link guests (the Review screen is the one renderer), and the
 * controller already paces around it. A server voice (Polly / OpenAI TTS)
 * would swap only speak() below; the mockups in mockups/commentator/ compare
 * them. Known limits: voice quality is the device's; iOS stops speech when
 * the screen locks; Safari needs a tap before the first utterance (the
 * toggle is that tap — a stored-on setting primes on the next pointerdown).
 *
 * Pure leaf (no imports): the mount site hands in the settings store
 * (settings/advancedSettings.js) so node:test can load this file.
 */

const SETTING_KEY = 'replay.narrate';
const VOICE_KEY = 'replay.voice';
const LEVEL_KEY = 'replay.narrateLevel';
const QUEUE_MAX = 3;            // 1× / Live: lines waiting behind the current one
const RATE = 1.04;
const START_TIMEOUT_MS = 1500;  // an utterance that never starts (no user gesture yet) is parked

const ICON_SPEAKER = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M2 6h2.5L8 3v10L4.5 10H2z"/><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6.3 6.3 0 0 1 0 9"/></svg>';
const ICON_GEAR = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" d="M6.8 1.8h2.4l.4 1.7 1.4.8 1.6-.6 1.2 2.1-1.3 1.1v1.6l1.3 1.1-1.2 2.1-1.6-.6-1.4.8-.4 1.7H6.8l-.4-1.7-1.4-.8-1.6.6-1.2-2.1 1.3-1.1V7l-1.3-1.1 1.2-2.1 1.6.6 1.4-.8z"/><circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';

/**
 * Voice profiles: the named voice first, then name patterns of comparable
 * voices on other platforms, then a language the profile's voice speaks.
 * `pitch` applies only when no named voice matched (the robot fallback).
 */
const VOICE_PROFILES = {
    male:   { label: 'Male',   names: ['Daniel'],   like: /Daniel|Arthur|Oliver|George|Guy|Ryan|Thomas|James|Alex|Male/i, lang: /^en-GB/i, pitch: 1, fallbackPitch: 0.85 },
    female: { label: 'Female', names: ['Samantha'], like: /Samantha|Karen|Moira|Tessa|Ava|Allison|Susan|Zoe|Aria|Jenny|Female|Google US English/i, lang: /^en-US/i, pitch: 1, fallbackPitch: 1 },
    robot:  { label: 'Robot',  names: ['Zarvox'],   like: /Zarvox|Trinoids|Cellos|Robot/i, lang: /^en/i, pitch: 1, fallbackPitch: 0.5, fallbackRate: 0.92 },
};
const LEVELS = { pbp: 'Play-by-play', events: 'Game events', score: 'Score only' };
const DEFAULT_VOICE = 'female';
const DEFAULT_LEVEL = 'pbp';

// ---------------------------------------------------------------- phrasing

const nameOf = ref => (ref && typeof ref === 'object' && ref.name) ? String(ref.name)
    : (typeof ref === 'string' ? ref : '');
/** Trim, drop the "(inferred)" prefix, collapse runs of spaces, end with a period. */
function sentence(text) {
    let t = String(text || '').replace(/\(inferred\)\s*/g, '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (!/[.!?]$/.test(t)) t += '.';
    return t;
}
/** "A, B, and C" — spoken list. */
function joinNames(names) {
    const n = names.filter(Boolean);
    if (n.length <= 1) return n.join('');
    if (n.length === 2) return `${n[0]} and ${n[1]}`;
    return `${n.slice(0, -1).join(', ')}, and ${n[n.length - 1]}`;
}

function phraseThrow(ev) {
    const t = nameOf(ev.thrower), r = nameOf(ev.receiver);
    if (!t) return sentence(typeof ev.summarize === 'function' ? ev.summarize() : '');
    if (ev.score_flag) {
        const how = ev.huck_flag ? ' deep' : ev.hammer_flag ? ' with the hammer' : '';
        const catchHow = ev.sky_flag ? ' Skies for it!' : ev.layout_flag ? ' Layout grab!' : '';
        return r ? `${t} to ${r}${how} for the goal!${catchHow}` : `${t}${how} for the goal!`;
    }
    const verb = ev.huck_flag ? 'hucks it to' : ev.hammer_flag ? 'hammers it to' : ev.reset_flag ? 'dumps it to'
        : ev.swing_flag ? 'swings it to' : ev.break_flag ? 'breaks the mark to' : 'to';
    if (!r) return sentence(`${t} ${verb === 'to' ? 'throws' : verb.replace(/ to$/, '')}`);
    const catchHow = ev.sky_flag ? ', who skies for it' : ev.layout_flag ? ', with a layout catch' : '';
    return sentence(`${t} ${verb} ${r}${catchHow}`);
}

function phraseTurnover(ev, ctx) {
    const t = nameOf(ev.thrower), r = nameOf(ev.receiver);
    const isPullDrop = typeof ev.isPullDrop === 'function' ? ev.isPullDrop() : (!!ev.drop_flag && !ev.thrower);
    if (isPullDrop) return sentence(`${r || ctx.teamName} drops the pull. Turnover`);
    if (ev.throwaway_flag) return sentence(`${t || ctx.teamName} throws it away${ev.huck_flag ? ' on the huck' : ''}. Turnover`);
    if (ev.drop_flag) {
        const what = ev.huck_flag ? 'the huck' : 'the throw';
        return sentence(`${r || 'The receiver'} drops ${t ? `${what} from ${t}` : 'it'}. Turnover`);
    }
    if (ev.stall_flag) return sentence(`${t || ctx.teamName} gets stalled out. Turnover`);
    if (ev.defense_flag) return 'Turnover, forced by the defense.';
    return sentence(t ? `Turnover by ${t}` : 'Turnover');
}

function phraseDefense(ev, ctx) {
    const d = nameOf(ev.defender);
    if (!d) return sentence(`${ctx.opponentName || 'The other team'} turns it over`);
    if (ev.Callahan_flag) return `Callahan by ${d}!`;
    if (ev.interception_flag) return `${d} with the interception!`;
    if (ev.layout_flag) return `Layout D by ${d}!`;
    if (ev.sky_flag) return `${d} skies for the D!`;
    if (ev.block_flag) return `Block by ${d}!`;
    if (ev.stall_flag) return sentence(`Stall! Forced by ${d}`);
    if (ev.unforcedError_flag) return sentence(`${ctx.opponentName || 'The other team'} turns it over`);
    return `${d} gets the D!`;
}

function phrasePull(ev) {
    const p = nameOf(ev.puller);
    const who = p || 'The pull';
    if (ev.quality === 'Brick' || ev.brick_flag) return sentence(p ? `${p}'s pull is out. Brick` : 'The pull is out. Brick');
    if (ev.quality === 'Good Pull') return sentence(`Good pull by ${p || 'the puller'}`);
    if (ev.quality === 'Poor Pull') return sentence(p ? `${p} pulls, and it's a short one` : 'A short pull');
    return sentence(p ? `${p} pulls` : `${who} is up`);
}

function phraseEvent(ev, ctx) {
    if (!ev) return '';
    switch (ev.type) {
        case 'Throw': return phraseThrow(ev);
        case 'Turnover': return phraseTurnover(ev, ctx);
        case 'Defense': return phraseDefense(ev, ctx);
        case 'Pull': return phrasePull(ev);
        case 'Pickup': return sentence(`${nameOf(ev.receiver) || 'Someone'} ${ev.pullCatch_flag ? 'catches the pull' : 'picks it up'}`);
        case 'Violation': return sentence(String(typeof ev.summarize === 'function' ? ev.summarize() : '')
            .replace(/^Violation called:\s*/, '').trim().replace(/\s+/g, ', ') + ' called');
        default: return sentence(typeof ev.summarize === 'function' ? ev.summarize() : '')
            .replace(/\s*—\s*/g, '. ').replace(/O & D/g, 'O and D');
    }
}

/**
 * The sentence to speak for one replay entry, or '' for silence.
 * @param {object} entry - GameLogEntry (utils/gameLogRenderer.js)
 * @param {object} [ctx]
 * @param {string} [ctx.teamName]
 * @param {string} [ctx.opponentName]
 * @param {string[]} [ctx.rosterNames] - the point's players as display names
 *   (when absent the roster line's own text is spoken)
 * @returns {string}
 */
function phraseEntry(entry, ctx = {}) {
    if (!entry) return '';
    const text = String(entry.text || '');
    switch (entry.kind) {
        case 'header':
        case 'teamroster':
        case 'possession':
            return '';
        case 'roster': {
            const m = /^Point (\d+) roster:\s*(.*)$/.exec(text);
            const n = m ? m[1] : '';
            const names = Array.isArray(ctx.rosterNames) ? joinNames(ctx.rosterNames) : (m ? m[2].trim() : '');
            if (!names) return n ? `Point ${n}.` : '';
            return `Point ${n}. On the line: ${names}.`;
        }
        case 'pullnote':
            return sentence(text);
        case 'event':
        case 'after':
            return phraseEvent(entry.event, ctx);
        case 'score': {
            if (/^Point over/.test(text)) return 'Point over, no score.';
            const m = /^(.*?) scores!(?: \((\d+) points\))?(?:\s+\[(.+?)\])?/.exec(text);
            if (!m) return sentence(text.replace(/\[|\]/g, ''));
            const who = m[1], pts = m[2], badge = m[3];
            let s = `${who} scores!`;
            if (pts) s += ` That's worth ${pts} points.`;
            if (badge) s += ` ${/^[aeiou]/i.test(badge) ? 'An' : 'A'} ${badge}.`;
            return s;
        }
        case 'currentscore': {
            const m = /^Current score: (.*) (\d+), (.*) (\d+)$/.exec(text);
            if (!m) return sentence(text.replace(/^Current score:\s*/, ''));
            const [, us, a, them, b] = m;
            const ua = +a, ub = +b;
            if (ua === ub) return `Tied at ${ua}.`;
            return ua > ub ? `${us} lead, ${ua} to ${ub}.` : `${them} lead, ${ub} to ${ua}.`;
        }
        case 'periodnote':
            return sentence(text.replace(/ play O\b/, ' play offense').replace(/ play D\b/, ' play defense'));
        default:
            return sentence(text);
    }
}

/** Lines the queue keeps when it has to drop plays. */
const isKeeper = entry => entry.kind === 'score' || entry.kind === 'currentscore' || entry.kind === 'gameover';

/**
 * The closing line once the game is over, from the last running-score entry:
 * "Game over. Us wins, 13 to 9." / "Game over. It ends tied at 10." The
 * renderer emits no game-over line of its own, so the narrator adds this
 * after the final score (synthetic entry kind 'gameover').
 * @param {object[]} entries - engine.entries
 * @returns {string} '' when there is no score line to read
 */
function gameOverSentence(entries) {
    let last = null;
    for (let i = entries.length - 1; i >= 0; i--) { if (entries[i].kind === 'currentscore') { last = entries[i]; break; } }
    if (!last) return '';
    const m = /^Current score: (.*) (\d+), (.*) (\d+)$/.exec(String(last.text || ''));
    if (!m) return 'Game over.';
    const [, us, a, them, b] = m;
    const ua = +a, ub = +b;
    if (ua === ub) return `Game over. It ends tied at ${ua}.`;
    return ua > ub ? `Game over. ${us} wins, ${ua} to ${ub}.` : `Game over. ${them} wins, ${ub} to ${ua}.`;
}
/** Index of the last running-score entry, or -1. */
function lastScoreIndex(entries) {
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].kind === 'currentscore') return i;
    return -1;
}

/**
 * Does the detail level want this entry spoken?
 *   'pbp'    everything phraseEntry voices
 *   'events' lineups ("Point N. On the line"), score lines, period notes,
 *            and the game's own events — timeouts, injury subs, halftime,
 *            side switches (the Other event type) — but no throws, D's or pulls
 *   'score'  score and running-score lines only
 */
function wantsEntry(entry, level) {
    if (!entry) return false;
    const lvl = LEVELS[level] ? level : DEFAULT_LEVEL;
    if (lvl === 'pbp') return true;
    if (entry.kind === 'score' || entry.kind === 'currentscore' || entry.kind === 'gameover') return true;
    if (lvl === 'score') return false;
    if (entry.kind === 'roster' || entry.kind === 'periodnote') return true;
    if ((entry.kind === 'event' || entry.kind === 'after') && entry.event && entry.event.type === 'Other') return true;
    return false;
}

// ----------------------------------------------------------------- voices

function listVoices(synth) {
    try { return synth.getVoices() || []; } catch (e) { return []; }
}

/**
 * Pick the voice for a setting value: a profile key ('male' / 'female' /
 * 'robot'), an exact voice name, or nothing (→ the default profile).
 * @returns {{voice: object|null, pitch: number, rate: number, profile: string|null, exact: boolean}}
 *   `exact` is true when the profile's own named voice was found; the menu
 *   tells the user when it was not.
 */
function resolveVoice(synth, setting) {
    const voices = listVoices(synth);
    const en = voices.filter(v => /^en\b/i.test(v.lang || ''));
    const byName = name => voices.find(v => v.name === name) || null;
    if (setting && !VOICE_PROFILES[setting]) {
        const v = byName(String(setting));
        if (v) return { voice: v, pitch: 1, rate: RATE, profile: null, exact: true };
    }
    const key = VOICE_PROFILES[setting] ? setting : DEFAULT_VOICE;
    const p = VOICE_PROFILES[key];
    for (const n of p.names) { const v = byName(n); if (v) return { voice: v, pitch: p.pitch, rate: RATE, profile: key, exact: true }; }
    const like = en.find(v => p.like.test(v.name)) || voices.find(v => p.like.test(v.name));
    if (like) return { voice: like, pitch: p.pitch, rate: RATE, profile: key, exact: false };
    // No comparable voice: a language match, then any English voice (local
    // first), with the profile's fallback pitch to keep male / robot distinct.
    const local = arr => arr.slice().sort((a, b) => (b.localService ? 1 : 0) - (a.localService ? 1 : 0) || (b.default ? 1 : 0) - (a.default ? 1 : 0));
    const byLang = local(en.filter(v => p.lang.test(v.lang || '')))[0] || local(en)[0] || voices[0] || null;
    return { voice: byLang, pitch: p.fallbackPitch, rate: p.fallbackRate || RATE, profile: key, exact: false };
}

// ----------------------------------------------------------------- mount

/**
 * @param {object} cfg
 * @param {object} cfg.controller - replayController
 * @param {object} cfg.engine - replayEngine (for the game's points, roster names)
 * @param {HTMLElement} cfg.transportEl - the .rv-transport bar; the settings
 *   menu is inserted right after it
 * @param {HTMLElement} [cfg.beforeEl] - insert the toggle before this child
 * @param {() => object} [cfg.getEntryOptions] - the buildGameLogEntries
 *   options (teamName / opponentName / resolvePlayerName)
 * @param {{get: Function, set: Function}} [cfg.settings] - persistent store for
 *   the toggle ('replay.narrate'), the voice ('replay.voice': male / female /
 *   robot, or an exact voice name) and the detail level ('replay.narrateLevel':
 *   pbp / events / score); advancedSettings at the real mount site, in-memory
 *   when absent
 * @param {object} [cfg.synth] - speechSynthesis stand-in (tests)
 * @param {Function} [cfg.Utterance] - SpeechSynthesisUtterance stand-in (tests)
 * @returns {{enabled: boolean, setEnabled: Function, cancel: Function, destroy: Function, button: HTMLElement|null, settingsButton: HTMLElement|null, menu: HTMLElement|null}|null}
 *   null when the browser has no speech synthesis (nothing mounted)
 */
function mountReplayNarrator(cfg) {
    const synth = cfg.synth || (typeof window !== 'undefined' ? window.speechSynthesis : null);
    const Utterance = cfg.Utterance || (typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : null);
    const { controller, engine, transportEl } = cfg;
    if (!synth || !Utterance || !controller || !transportEl) return null;
    const doc = transportEl.ownerDocument;
    const settings = cfg.settings || (() => { const m = {}; return { get: k => m[k], set: (k, v) => { m[k] = v; } }; })();

    let enabled = settings.get(SETTING_KEY) === true;
    const voiceSetting = () => settings.get(VOICE_KEY) || DEFAULT_VOICE;
    const level = () => { const l = settings.get(LEVEL_KEY); return LEVELS[l] ? l : DEFAULT_LEVEL; };
    const queue = [];             // [{ text, entry, resolve }]
    let current = null;           // the utterance speaking now
    let parked = null;            // an item whose utterance never started (no gesture yet)
    let primer = null;            // the one-shot pointerdown that retries `parked`
    const offs = [];

    // ---- toggle + settings button ----
    const btn = doc.createElement('button');
    btn.className = 'rv-tbtn rv-narrate';
    btn.type = 'button';
    btn.innerHTML = ICON_SPEAKER;
    const gear = doc.createElement('button');
    gear.className = 'rv-tbtn rv-narrate-cfg';
    gear.type = 'button';
    gear.innerHTML = ICON_GEAR;
    gear.title = 'Narration settings';
    gear.setAttribute('aria-label', 'Narration settings');
    gear.hidden = true;
    const renderBtn = () => {
        btn.classList.toggle('on', enabled);
        btn.title = enabled ? 'Narration on — tap to mute' : 'Narrate plays';
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        gear.hidden = !enabled;
        // Lets the stylesheet tighten a phone's transport while the ⚙ is showing.
        if (transportEl.classList && typeof transportEl.classList.toggle === 'function') transportEl.classList.toggle('rv-narrating', enabled);
        if (!enabled) closeMenu();
    };
    const anchor = cfg.beforeEl && cfg.beforeEl.parentNode === transportEl ? cfg.beforeEl : null;
    transportEl.insertBefore(btn, anchor);
    transportEl.insertBefore(gear, anchor);

    // ---- settings menu (voice, detail level) ----
    const menu = doc.createElement('div');
    menu.className = 'rv-nmenu';
    menu.hidden = true;
    menu.setAttribute('role', 'group');
    menu.setAttribute('aria-label', 'Narration settings');
    const chip = (attr, key, label) => `<button type="button" class="rv-nchip" data-${attr}="${key}">${label}</button>`;
    menu.innerHTML =
        `<div class="rv-nmenu-row"><span class="rv-nmenu-lbl">Voice</span>` +
        Object.keys(VOICE_PROFILES).map(k => chip('voice', k, VOICE_PROFILES[k].label)).join('') + `</div>` +
        `<div class="rv-nmenu-note" data-note="voice"></div>` +
        `<div class="rv-nmenu-row"><span class="rv-nmenu-lbl">Narrate</span>` +
        Object.keys(LEVELS).map(k => chip('level', k, LEVELS[k])).join('') + `</div>`;
    if (transportEl.parentNode) transportEl.parentNode.insertBefore(menu, transportEl.nextSibling);
    const q = sel => (typeof menu.querySelectorAll === 'function' ? Array.from(menu.querySelectorAll(sel)) : []);
    function renderMenu() {
        const v = voiceSetting(), l = level();
        q('[data-voice]').forEach(el => el.classList.toggle('on', el.dataset.voice === v));
        q('[data-level]').forEach(el => el.classList.toggle('on', el.dataset.level === l));
        const note = q('[data-note="voice"]')[0];
        if (note) {
            const r = resolveVoice(synth, v);
            const p = VOICE_PROFILES[r.profile];
            if (!r.voice) note.textContent = 'No voices on this device yet.';
            else if (r.exact || !p) note.textContent = `Using ${r.voice.name}.`;
            else note.textContent = `${p.names[0]} isn't on this device; using ${r.voice.name}.`;
        }
    }
    function openMenu() { renderMenu(); menu.hidden = false; gear.classList.add('on'); doc.addEventListener('pointerdown', outside, true); }
    function closeMenu() { if (menu.hidden) return; menu.hidden = true; gear.classList.remove('on'); doc.removeEventListener('pointerdown', outside, true); }
    const outside = ev => {
        const t = ev.target;
        const inside = n => n && typeof n.contains === 'function' && n.contains(t);
        if (!inside(menu) && !inside(gear)) closeMenu();
    };
    gear.addEventListener('click', () => { if (menu.hidden) openMenu(); else closeMenu(); });
    menu.addEventListener('click', ev => {
        const el = ev.target && typeof ev.target.closest === 'function' ? ev.target.closest('[data-voice],[data-level]') : null;
        if (!el) return;
        if (el.dataset.voice) {
            settings.set(VOICE_KEY, el.dataset.voice);
            renderMenu();
            // Hear the pick right away (and it is a tap, so Safari lets it play).
            cancel();
            queue.push({ text: `This is the ${VOICE_PROFILES[el.dataset.voice].label.toLowerCase()} voice.`, entry: { kind: 'cue' }, resolve: null });
            speakNext();
        } else if (el.dataset.level) {
            settings.set(LEVEL_KEY, el.dataset.level);
            renderMenu();
        }
    });
    renderBtn();

    function ctxFor(entry) {
        const o = (typeof cfg.getEntryOptions === 'function' && cfg.getEntryOptions()) || {};
        const game = engine && engine.game;
        const ctx = { teamName: o.teamName || (game && game.team), opponentName: o.opponentName || (game && game.opponent) };
        if (entry.kind === 'roster' && game && entry.pointIdx != null) {
            const point = (game.points || [])[entry.pointIdx];
            const resolve = typeof o.resolvePlayerName === 'function' ? o.resolvePlayerName : (p => p);
            if (point && Array.isArray(point.players)) ctx.rosterNames = point.players.map(p => { try { return String(resolve(p)); } catch (e) { return String(p); } });
        }
        return ctx;
    }

    // ---- queue ----
    function finish(item) { if (item && item.resolve) { item.resolve(); item.resolve = null; } }
    function cancel() {
        clearPrimer();
        parked = null;
        const was = current; current = null;
        queue.splice(0).forEach(finish);
        finish(was);
        try { synth.cancel(); } catch (e) { /* no voice */ }
    }
    function clearPrimer() { if (primer) { doc.removeEventListener('pointerdown', primer, true); primer = null; } }
    function armPrimer() {
        if (primer) return;
        primer = () => { clearPrimer(); const p = parked; parked = null; if (p && enabled) { queue.unshift(p); speakNext(); } };
        doc.addEventListener('pointerdown', primer, true);
    }
    function speakNext() {
        if (current || !queue.length) return;
        const item = queue.shift();
        current = item;
        let started = false;
        const u = new Utterance(item.text);
        const r = resolveVoice(synth, voiceSetting());
        if (r.voice) { u.voice = r.voice; u.lang = r.voice.lang; }
        u.rate = r.rate;
        u.pitch = r.pitch;
        const done = () => {
            if (current !== item) return;
            current = null;
            finish(item);
            speakNext();
        };
        u.onstart = () => { started = true; };
        u.onend = done;
        u.onerror = done;
        try { synth.resume(); } catch (e) { /* ignore */ }
        try { synth.speak(u); } catch (e) { done(); return; }
        // Safari refuses speech before the page's first tap: the utterance
        // neither starts nor errors. Park it and retry on the next pointerdown.
        // (Every utterance goes through this queue, the toggle's cue included,
        // so nothing else can be holding the engine when this fires.)
        setTimeout(() => {
            if (started || current !== item) return;
            try { synth.cancel(); } catch (e) { /* ignore */ }
            current = null;
            parked = item;
            armPrimer();
        }, START_TIMEOUT_MS);
    }
    function enqueue(entry, text) {
        const speed = controller.state.speed;
        let resolve = null;
        const hold = speed === 'pap' ? new Promise(r => { resolve = r; }) : null;
        const item = { text, entry, resolve };
        if (typeof speed === 'number' && speed > 1) {
            // Fast replay: only the newest line matters.
            cancel();
            queue.push(item);
        } else {
            queue.push(item);
            while (queue.length > QUEUE_MAX) {
                const i = queue.findIndex((q, idx) => idx < queue.length - 1 && !isKeeper(q.entry));
                if (i < 0) break;
                finish(queue.splice(i, 1)[0]);
            }
        }
        speakNext();
        return hold;
    }

    // ---- game over ----
    // Spoken once after the final score: on a finished game's replay, right
    // behind the last running-score line; on a live game, when the sync that
    // ends the game arrives while following the tail (no entry fires for
    // that, so the transport hook watches engine.isFinished() flip). Seeking
    // back before the last score re-arms it for the next pass.
    const finished = () => !!(engine && typeof engine.isFinished === 'function' && engine.isFinished());
    let gameOverSaid = false;
    function announceGameOver() {
        if (gameOverSaid || !enabled) return;
        const text = gameOverSentence(engine.entries || []);
        if (!text) return;
        gameOverSaid = true;
        const entry = { kind: 'gameover', text };
        if (!wantsEntry(entry, level())) return;
        enqueue(entry, text);
    }

    // ---- controller hooks ----
    offs.push(controller.on('entry', ({ index, entry }) => {
        if (!enabled || !entry || !wantsEntry(entry, level())) return undefined;
        const text = phraseEntry(entry, ctxFor(entry));
        if (!text) return undefined;
        const hold = enqueue(entry, text);
        if (entry.kind === 'currentscore' && finished() && index === lastScoreIndex(engine.entries || [])) announceGameOver();
        return hold;
    }));
    // A seek (field without animation) or a pause stops the voice with the field.
    offs.push(controller.on('field', ({ index, animate }) => {
        if (!animate && (current || queue.length)) cancel();
        if (index < lastScoreIndex(engine.entries || [])) gameOverSaid = false;
    }));
    // Pause in place stops the voice. A step forward also flips playing off,
    // but it advances the index — that line was just enqueued, so keep it.
    let lastPlaying = null, lastIndex = null, wasFinished = finished();
    offs.push(controller.on('transport', s => {
        if (lastPlaying === true && !s.playing && s.index === lastIndex) cancel();
        lastPlaying = s.playing; lastIndex = s.index;
        const nowFinished = finished();
        if (nowFinished && !wasFinished && s.follow && s.atTail) announceGameOver();
        wasFinished = nowFinished;
    }));

    function setEnabled(on) {
        enabled = !!on;
        settings.set(SETTING_KEY, enabled);
        renderBtn();
        if (!enabled) cancel();
    }
    btn.addEventListener('click', () => {
        setEnabled(!enabled);
        if (enabled) {
            // The tap is the user gesture Safari wants; a short cue confirms
            // the voice works and warms the engine (Chrome's first utterance
            // after a long idle is otherwise swallowed).
            queue.push({ text: 'Narration on.', entry: { kind: 'cue' }, resolve: null });
            speakNext();
        }
    });

    function destroy() {
        cancel();
        closeMenu();
        offs.forEach(off => { try { off(); } catch (e) { /* already gone */ } });
        offs.length = 0;
        btn.remove();
        gear.remove();
        menu.remove();
    }

    return { get enabled() { return enabled; }, setEnabled, cancel, destroy, button: btn, settingsButton: gear, menu };
}

export { phraseEntry, wantsEntry, resolveVoice, gameOverSentence, mountReplayNarrator, VOICE_PROFILES, LEVELS };
