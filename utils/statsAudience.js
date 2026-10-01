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

// --- ES-module exports ---
export {
    setGuestStatsLevel, teamViewerStatsLevel, lockedStatsLevel,
    activeStatsLevel, wireActiveStatsLevelSelect,
};
