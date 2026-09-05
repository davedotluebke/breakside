/*
 * Field replay for the public viewer (docs/replay-viewer-plan.md, Decision 4c
 * — the share-viewer port). Mounts the PWA's own replay view (pitch,
 * transport, point timeline) above the per-point cards and wires the cards
 * as the "log": each event row / possession header gets a data-entry index
 * so the view can highlight the current line and seek on tap.
 *
 * This is an ES module because it imports the PWA's leaf modules by RELATIVE
 * path — the same files resolve from /viewer/ (S3, beside the PWA) and from
 * /static/viewer/ (the API host mounts playByPlay/, store/, utils/,
 * settings/, css/ under /static/). Only LEAF modules may be reached from
 * here; tests/unit/replayLeafGraph.test.mjs pins the allowlist.
 *
 * viewer.js (a classic script) drives it through window.viewerReplay:
 *   update(game, { live })   after every renderGame — raw JSON in, hydrated
 *                            into model events (store/models.js hydrateGame)
 *   destroy()                when leaving the game detail view
 *
 * Nothing here is editable: the view gets no canEdit, so the ✎ never shows.
 */
// One level up resolves to the PWA root on S3 (/viewer/ → /) and to the
// mounted copies on the API host (/static/viewer/ → /static/). NOT a
// file-system path: tests/unit/replayLeafGraph.test.mjs maps it.
import { mountReplayView } from '../playByPlay/replayView.js';
import { hydrateGame } from '../store/models.js';

let view = null;
let hydrated = null;
let entryOptions = null;
let offField = null;

const $ = id => document.getElementById(id);

/** viewer.js's id→name resolver (a classic-script global), when present. */
function resolveName(id, name) {
    if (name) return name;
    if (id && typeof window.resolvePlayerName === 'function') {
        try { return window.resolvePlayerName(id); } catch (e) { /* fall through */ }
    }
    return id || null;
}

/** Jersey numbers for actor labels, when the roster snapshot carries them. */
function playerByName(name) {
    const players = (hydrated && hydrated.rosterSnapshot && hydrated.rosterSnapshot.players) || [];
    const p = players.find(x => x && (x.name === name || x.nickname === name));
    return p ? { name, number: p.number != null ? p.number : null } : null;
}

/**
 * Stamp data-entry onto the cards so the view's line marking / tap-to-seek
 * work: 'event' and 'after' entries → their .event-item, 'possession'
 * entries → the possession header. Point headers are left alone (a tap
 * there toggles the card, and the timeline already seeks by point).
 */
function stampEntries() {
    const host = $('points-container');
    if (!host || !view) return;
    host.querySelectorAll('[data-entry]').forEach(el => { el.removeAttribute('data-entry'); el.classList.remove('rv-cur', 'rv-future'); });
    view.engine.entries.forEach((e, i) => {
        if (e.pointIdx === null || e.pointIdx === undefined) return;
        let el = null;
        if ((e.kind === 'event' || e.kind === 'after') && e.possIdx !== null && e.eventIdx !== null) {
            el = host.querySelector(`.point-card[data-point="${e.pointIdx}"] .possession[data-poss="${e.possIdx}"] .event-item[data-ev="${e.eventIdx}"]`);
        } else if (e.kind === 'possession' && e.possIdx !== null) {
            el = host.querySelector(`.point-card[data-point="${e.pointIdx}"] .possession[data-poss="${e.possIdx}"] .possession-header`);
        }
        if (el) el.setAttribute('data-entry', String(i));
    });
}

/** Keep the card under the playhead open and its line in view. */
function followPlayhead({ index, state }) {
    const host = $('points-container');
    if (!host || !view) return;
    if (state && state.pointIdx !== null && state.pointIdx !== undefined) {
        const content = host.querySelector(`.point-card[data-point="${state.pointIdx}"] .point-content`);
        if (content && !content.classList.contains('expanded')) content.classList.add('expanded');
    }
    const line = host.querySelector(`[data-entry="${index}"]`);
    if (line && typeof line.scrollIntoView === 'function') line.scrollIntoView({ block: 'nearest', behavior: 'auto' });
}

/**
 * The page header is sticky too: stack the stage under it, not behind it.
 * The header's height changes with the viewport (it wraps on a phone), so
 * this runs on every update and on resize.
 */
function stackUnderHeader() {
    const host = $('replay-host');
    const header = document.querySelector('.main-header');
    if (!host || !header) return;
    if (/sticky|fixed/.test(getComputedStyle(header).position)) {
        host.style.top = `${Math.round(header.getBoundingClientRect().height)}px`;
    }
}
window.addEventListener('resize', stackUnderHeader);

function update(rawGame, opts) {
    opts = opts || {};
    const host = $('replay-host'), logEl = $('points-container');
    if (!host || !logEl || !rawGame) return;
    hydrated = hydrateGame(rawGame, resolveName);
    entryOptions = {
        teamName: rawGame.team || 'Team',
        opponentName: rawGame.opponent || 'Opponent',
        resolvePlayerName: entry => resolveName(entry, null) || entry,
    };
    stackUnderHeader();
    if (!view) {
        view = mountReplayView({
            host, logEl,
            getGame: () => hydrated,
            getEntryOptions: () => entryOptions,
            getPlayerByName: playerByName,
            live: opts.live !== false,
        });
        if (!view) return;                       // no located events: nothing mounted
        offField = view.controller.on('field', followPlayhead);
        stampEntries();
        view.onShown();
        return;
    }
    // Re-rendered cards are new elements: re-stamp, then let the view
    // rebuild its engine (live-follow animates the new tail).
    view.onLogUpdated();
    stampEntries();
    view.onLogUpdated();
}

function destroy() {
    if (offField) { try { offField(); } catch (e) { /* gone */ } offField = null; }
    if (view) { try { view.destroy(); } catch (e) { /* gone */ } view = null; }
    hydrated = null;
}

// window survivor: the viewer's classic script (viewer.js) reaches this
// module through the window — the only bridge between a classic script and
// an ES module without a bundler.
window.viewerReplay = { update, destroy };
