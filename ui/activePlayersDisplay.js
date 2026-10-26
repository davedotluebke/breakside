/*
 * Active Players Display
 *
 * What's left here is two small helpers used by the Line tab. The rest of
 * this file used to render a sticky "active players" table on a Before Point
 * Screen that no longer exists — see the note on clearNextLineSelections
 * below, and ARCHITECTURE.md § Line tab table for where that UI lives now
 * (game/selectLine.js, #panelActivePlayersTable).
 */
import { currentGame } from '../utils/helpers.js';
import { pointValueOf } from '../store/scrimmageRules.js';
import { log } from '../utils/logger.js';

let nextLineSelections = null;

/**
 * Calculate running scores for team and opponent.
 *
 * Returns {team: number[], opponent: number[]}, each starting at 0 and
 * gaining an entry per point — so index N is the score after N points.
 * game/selectLine.js uses these for the Line tab's per-point score header.
 */
function getRunningScores() {
    const runningScores = { team: [0], opponent: [0] };
    currentGame().points.forEach(point => {
        // pointValueOf: 1 ordinarily, 2 for a two-point play, 0 for a no-score rep
        const value = pointValueOf(point);
        runningScores.team.push(runningScores.team.slice(-1)[0] + (point.winner === 'team' ? value : 0));
        runningScores.opponent.push(runningScores.opponent.slice(-1)[0] + (point.winner === 'opponent' ? value : 0));
    });
    return runningScores;
}

/**
 * Clear stored next line selections.
 *
 * NOTE: currently a no-op, and kept only because three modules still call it
 * (game/gameLogic.js, game/pointManagement.js, game/selectLine.js). The only
 * writer of `nextLineSelections` was captureNextLineSelections(), part of the
 * dead Before-Point-Screen table deleted in this file's cleanup — nothing has
 * called it since that screen went away, so the variable is permanently null
 * and clearing it changes nothing. Line selection now persists through
 * `pendingNextLine` on the Game (see game/selectLine.js).
 *
 * Removing this function and its four call sites is a safe follow-up; it was
 * left in place so the dead-table deletion stayed contained to this file.
 */
function clearNextLineSelections() {
    if (nextLineSelections !== null) {
        log('Clearing next line selections (was:', nextLineSelections, ')');
    }
    nextLineSelections = null;
}

// --- ES-module exports ---
export { clearNextLineSelections, getRunningScores };
