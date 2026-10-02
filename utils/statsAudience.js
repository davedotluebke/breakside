/*
 * Who is looking at the stats, and which level they may see.
 *
 * A team can restrict its viewers to one stats level — today only Fun
 * (utils/funStats.js), the youth shout-outs — via Team Settings, stored on the
 * team as `viewerStatsLevel` ('fun', or null for no restriction). It applies
 * to:
 *
 *   - a signed-in viewer of the team (store/storage.js isViewer()), on every
 *     stats screen and in the Export dialog;
 *   - a share-link guest watching one of the team's games: the public share
 *     payload carries the team's level (breakside_server/routers/shares.py)
 *     and teams/shareGuest.js hands it to setGuestStatsLevel().
 *
 * Coaches are never restricted; they pick any level from the Stats menu.
 *
 * This decides what the app SHOWS. The stats are computed in the browser from
 * the game's event log, which viewers receive whole (the replay and the game
 * log need it), so it is a presentation choice, not access control.
 */
import { currentTeam, isViewer } from '../store/storage.js';
import { StatsLevel, getStatsLevel, wireStatsLevelSelect } from './statsLevel.js';
import { TOP_N, positiveIntOrNull } from './funStats.js';

const RESTRICTABLE = new Set([StatsLevel.FUN]);

let guestStatsLevel = null;

/** A share guest's restriction, from the share payload (null = none). */
function setGuestStatsLevel(level) {
    guestStatsLevel = RESTRICTABLE.has(level) ? level : null;
}

/** The team setting's value, normalised: a restrictable level or null. */
function teamViewerStatsLevel(team) {
    const level = team && team.viewerStatsLevel;
    return RESTRICTABLE.has(level) ? level : null;
}

/** The level this user is held to, or null when they may choose freely. */
function lockedStatsLevel() {
    if (guestStatsLevel) return guestStatsLevel;
    if (isViewer()) return teamViewerStatsLevel(currentTeam);
    return null;
}

/** The level the stats screens and exports should use right now. */
function activeStatsLevel() {
    return lockedStatsLevel() || getStatsLevel();
}

/** wireStatsLevelSelect, locked when this user is restricted. */
function wireActiveStatsLevelSelect(select, onChange) {
    wireStatsLevelSelect(select, onChange, { lockedTo: lockedStatsLevel() });
}

// ── Fun options ─────────────────────────────────────────────────────────
// How many players each shout-out names, and the throws Comp% needs (null =
// automatic, utils/funStats.js defaultMinCompThrows). Per device, like the
// Stats menu. A user held to Fun gets the defaults and no controls: letting a
// viewer ask for "top 20" would rebuild the full ranking Fun exists to avoid.

const FUN_TOP_N_KEY = 'funStatsTopN';
const FUN_MIN_THROWS_KEY = 'funStatsMinThrows';

function readPref(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
}
function writePref(key, value) {
    try {
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, String(value));
    } catch (e) { /* private mode */ }
}

/** May this user change the Fun options? (No when held to Fun.) */
function funOptionsEditable() {
    return !lockedStatsLevel();
}

/** {topN, minCompThrows} for buildFunStats; minCompThrows null = automatic. */
function getFunOptions() {
    if (!funOptionsEditable()) return { topN: TOP_N, minCompThrows: null };
    return {
        topN: positiveIntOrNull(readPref(FUN_TOP_N_KEY)) || TOP_N,
        minCompThrows: positiveIntOrNull(readPref(FUN_MIN_THROWS_KEY)),
    };
}

/** Persist the Fun options (ignored when held to Fun). Blank minCompThrows = automatic. */
function setFunOptions({ topN, minCompThrows } = {}) {
    if (!funOptionsEditable()) return;
    if (topN !== undefined) writePref(FUN_TOP_N_KEY, positiveIntOrNull(topN));
    if (minCompThrows !== undefined) writePref(FUN_MIN_THROWS_KEY, positiveIntOrNull(minCompThrows));
}

// --- ES-module exports ---
export {
    setGuestStatsLevel, teamViewerStatsLevel, lockedStatsLevel,
    activeStatsLevel, wireActiveStatsLevelSelect,
    funOptionsEditable, getFunOptions, setFunOptions,
};
