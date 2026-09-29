/*
 * Lineup Narration — speak the next line on the Lines tab.
 *
 * A layer on the shared capture machinery (narration/rosterNarration.js: the
 * state machine, the status strip, the request, the toasts), with its own
 * backend endpoint (/api/narration/lineup). Its sibling is squad narration
 * (narration/squadNarration.js), which does the same for a scrimmage's two
 * squads. It never touches the in-point narration engine beyond checking
 * that it's idle — they can't record at once because they share the
 * realtime-session singleton.
 *
 * No button of its own: the floating mic FAB (narration/micButton.js) routes
 * to this layer whenever a line, rather than play, is what the coach would be
 * narrating, and drives start()/stop() with the same tap-toggle /
 * hold-to-record gestures it uses for event narration. This module owns what
 * is the Lines tab's: where the strip goes (under the Select Line toolbar),
 * what the server is told, and how its answer is applied.
 *
 * Flow:
 *   tap the mic → transcription session opens (vocabulary biased to the
 *   FULL active roster — calling a line names bench players) → coach speaks
 *   ("Kris goes in for Wes", "same line but…", "two more women", "the guys
 *   come off", "auto the rest", corrections) → tap again → transcript + roster (with each
 *   player's gender group) + expected count + previous lineup + current
 *   selection POST to /api/narration/lineup → the returned players are
 *   applied through selectLine's applyLineSelection (the same path as the
 *   Auto button), and any counts the server could only verify ("two more
 *   women") are filled here by Auto's own rules (computeAutoLine). A voiced
 *   Auto ("auto the rest", "auto-pick the FMPs") is the Auto button itself,
 *   run here over what the coach named.
 *   A name the recognizer mangled is resolved against the closed roster by
 *   the server (narration_common.py), as for squads.
 */
import { createRosterNarration, rosterInfo, rosterForServer } from './rosterNarration.js';
import { resolveLineupPlayers, buildLineupToast, displayFirstName, autoEmptyText } from './lineupResolve.js';
import { log } from '../utils/logger.js';
import { getActiveRoster } from '../store/storage.js';
import { currentGame, buildPointPlayerLookup } from '../utils/helpers.js';
import {
    applyLineSelection, canEditSelectLinePanel, computeAutoLine, autoLinePositionShortfall,
} from '../game/selectLine.js';
import { getActiveTab } from '../ui/panelSystem.js';

// showControllerToast's own default, which the confirmation toast scales
// off. It reports a whole line ("7/7 selected. Added: Kris. Off: Wes") and
// flags a miscount, so it needs reading time, not glance time — 3x on the
// Line tab, where the checkboxes next to it already tell the story, and
// double that again elsewhere, where the toast IS the only feedback.
const TOAST_BASE_MS = 4000;
const CONFIRM_TOAST_MS = TOAST_BASE_MS * 3;
const CONFIRM_TOAST_OFF_LINE_TAB_MS = CONFIRM_TOAST_MS * 2;

const NEED_ROLE = 'You need a coach role to change the line';

function getExpectedCount() {
    // Same idiom as selectLine.js — the game-settings field, default 7.
    return parseInt(document.getElementById('playersOnFieldInput')?.value || '7', 10);
}

/** Names of the last point's line — who just played / is on the field.
 *  Entries may be ids (id-era games); resolve through the era-aware lookup. */
function getPreviousLineupNames(game) {
    if (!game || !game.points || !game.points.length) return [];
    const pt = game.points[game.points.length - 1];
    if (!pt || !pt.players || !pt.players.length) return [];
    const lookup = buildPointPlayerLookup(game);
    return pt.players.map(entry => lookup(entry).name).filter(Boolean);
}

/** Names currently selected on the active line bucket (what we replace). */
function getCurrentSelectionNames(game) {
    const pending = game && game.pendingNextLine;
    if (!pending) return [];
    const activeType = pending.activeType || 'od';
    const entries = pending[activeType + 'Line'] || [];
    if (!entries.length) return [];
    const lookup = buildPointPlayerLookup(game);
    return entries.map(entry => lookup(entry).name).filter(Boolean);
}

/**
 * The Lines tab as it stands, or why a line cannot be narrated right now.
 * Asked again at every stage: the game can end, and the Line Coach role can
 * move, while the coach is still talking.
 */
function readContext(stage) {
    const game = typeof currentGame === 'function' ? currentGame() : null;
    const roster = typeof getActiveRoster === 'function' ? getActiveRoster() : null;
    if (stage === 'process' || stage === 'apply') {
        if (!game || !roster || !roster.length) {
            return { problem: 'Voice lineup failed — game context lost', level: 'error' };
        }
    }
    if (!game) return { problem: 'Open a game to narrate a lineup' };
    if (stage !== 'process' && !canEditSelectLinePanel()) return { problem: NEED_ROLE };
    if (!roster || !roster.length) return { problem: 'No roster to match a lineup against' };
    return { ctx: { game, roster } };
}

/**
 * Apply the backend's lineup to the Lines tab. The server returns the FULL
 * resulting selection — the coach's words applied to the current one by set
 * arithmetic — so applying is a plain replace, plus the counts it could
 * only verify ("two more women"), which are filled here by the Auto
 * button's own rules, and then a voiced Auto ("auto the rest"), which is
 * that button. The toast reports the DELTA ("Added: …", "Off: …").
 * Never applies a result in which nothing was heard: a wrong no-op beats
 * wiping the coach's selection.
 */
function applyLineup(data, { game, roster }, { toast, showConfirmToast }) {
    const returned = Array.isArray(data.players) ? data.players : [];
    const modelUnmatched = Array.isArray(data.unmatched) ? data.unmatched : [];
    const fills = Array.isArray(data.fills) ? data.fills.filter(f => f && f.count > 0) : [];
    const autos = Array.isArray(data.voiced_auto)
        ? data.voiced_auto.filter(g => g === 'ANY' || g === 'FMP' || g === 'MMP')
        : [];
    // Something for the Lines tab to pick: a result with only this in it is
    // still a line call, never "nothing heard".
    const picks = fills.length > 0 || autos.length > 0;
    // A voiced clear ("wholesale", "everybody comes off"), explicit removals
    // or a group coming off legitimately empty the selection — distinguish
    // that from "nothing lineup-related was heard", which must never wipe.
    const voicedClear = data.voiced_clear === true;
    const voicedOut = Array.isArray(data.voiced_out) ? data.voiced_out : [];
    const groupOut = Array.isArray(data.voiced_group_out) ? data.voiced_group_out : [];
    const legitimatelyEmpty = voicedClear || voicedOut.length > 0 || groupOut.length > 0;
    if (!returned.length && !modelUnmatched.length && !legitimatelyEmpty && !picks) {
        toast('No lineup heard', 'info');
        return false;
    }

    const { players, unmatched: localUnmatched } = resolveLineupPlayers(returned, roster);
    const unmatched = modelUnmatched.concat(localUnmatched);

    if (!players.length && !legitimatelyEmpty && !picks) {
        const shown = unmatched.slice(0, 3).map(u => `"${u}"`).join(', ');
        toast(`No roster match: ${shown}${unmatched.length > 3 ? ', …' : ''} — selection unchanged`, 'warning');
        return false;
    }

    // Narrated counts, in spoken order: the coach said how many and of which
    // group; who is Auto's call (position, rest, O/D line, playing time —
    // game/selectLine.js computeAutoLine), exactly as if the coach had
    // tapped Auto with only those slots open.
    let newNames = players.map(p => p.name);
    const shortfalls = [];
    fills.forEach(fill => {
        const before = newNames.length;
        newNames = computeAutoLine(newNames, {
            count: fill.count,
            eligible: p => fill.group === 'ANY' || p.gender === fill.group,
        });
        const got = newNames.length - before;
        if (got < fill.count) shortfalls.push({ group: fill.group, wanted: fill.count, got });
    });

    // A voiced Auto, after the names and the counts: the Auto button's own
    // computation over the line so far (field count, gender ratio, then the
    // coach's priority order). "Auto the rest" keeps all of it; "auto-pick
    // the FMPs" keeps the players of that group Auto chose and leaves the
    // other slots open for the coach.
    const notes = [];
    const genderOf = new Map(roster.map(p => [p.name, p.gender]));
    let autoFilledLine = false;
    autos.forEach(group => {
        const have = new Set(newNames);
        const picked = computeAutoLine(newNames)
            .filter(n => !have.has(n) && (group === 'ANY' || genderOf.get(n) === group));
        if (!picked.length) { notes.push(autoEmptyText(group)); return; }
        newNames = newNames.concat(picked);
        if (group === 'ANY') autoFilledLine = true;
    });
    // The Auto button's own warning, when it completed the line.
    if (autoFilledLine) {
        const short = autoLinePositionShortfall(newNames);
        const missing = [short.handlers && 'handlers', short.cutters && 'cutters'].filter(Boolean);
        if (missing.length) notes.push(`Auto line may have too few ${missing.join(' and ')}`);
    }

    // Delta vs the selection being replaced — what this voice action did.
    const prevNames = getCurrentSelectionNames(game);
    const prevSet = new Set(prevNames);
    const newSet = new Set(newNames);
    const added = newNames.filter(n => !prevSet.has(n)).map(displayFirstName);
    const removed = prevNames.filter(n => !newSet.has(n)).map(displayFirstName);

    applyLineSelection('main', newNames);

    // The model's free-text note is for debugging, not the sideline.
    if (data.note) log('[lineupNarration] note:', data.note);
    const { message, type } = buildLineupToast({
        selectedCount: newNames.length,
        expectedCount: getExpectedCount(),
        added, removed, unmatched, shortfalls, notes
    });
    showConfirmToast(message, type);
    return true;
}

const layer = createRosterNarration({
    name: 'lineupNarration',
    label: 'Lineup',
    voiceLabel: 'Voice lineup',
    unchanged: 'selection',
    endpoint: '/api/narration/lineup',
    resultChannel: 'lineupResolved',
    statusId: 'lineupNarrationStatus',
    statusAnchor: () => document.querySelector('.panel-selectLine .select-line-toolbar'),
    listeningHint: () => 'Listening — name the line, or say "Kris in for Wes", "two more women", "auto the rest"',
    processingLabel: 'Working out the lineup…',
    busyMessage: 'Still working out the previous lineup…',
    otherRunningMessage: 'Game narration is running — stop it before narrating the lineup',
    context: readContext,
    // The FULL roster — a line call names bench players, so on-field-only
    // biasing (the in-point default) would miss exactly the names that matter.
    // "Auto" rides along as a roster-shaped entry so the recognizer writes
    // the word a voiced Auto turns on (and not the name "Otto").
    vocabulary: ({ roster }) => rosterInfo(roster).concat([{ name: 'Auto' }]),
    buildPayload: ({ game, roster }, transcript) => ({
        game_id: game.id || null,
        transcript,
        roster: rosterForServer(roster),
        expected_count: getExpectedCount(),
        previous_lineup: getPreviousLineupNames(game),
        current_selection: getCurrentSelectionNames(game)
    }),
    apply: applyLineup,
    confirmToastMs: () => ((typeof getActiveTab === 'function') && getActiveTab() === 'line')
        ? CONFIRM_TOAST_MS
        : CONFIRM_TOAST_OFF_LINE_TAB_MS,
});

// Navigating to any nav-managed screen means leaving the game (the
// panel-based game screen isn't one of them, so this only fires on the
// way out) — the line report is moot once the coach is elsewhere.
document.addEventListener('breakside:screen-shown', layer.dismissConfirmToast);

// Public API — driven by narration/micButton.js whenever a line, rather
// than play, is what the coach would be narrating.
const lineupNarration = {
    ...layer,
    // Point start = the coach accepted this line and moved on; called
    // window-qualified by game/pointManagement.js startNextPoint.
    onPointStarted: layer.dismissConfirmToast,
};

// --- ES-module export ---
export { lineupNarration };
// window survivor: debug/e2e seam — lets the console and Playwright drive
// the apply path (lineupNarration._applyResult) and the typed-transcript
// path (lineupNarration._narrate) without mic hardware; mirrors the
// computeAutoLine seam.
window.lineupNarration = lineupNarration;
