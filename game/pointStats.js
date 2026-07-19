/*
 * Per-player live-counter updates for a scored point: apply + revert as an
 * inseparable pair. Extracted from gameLogic.updateScore/revertPointScore so
 * the pairing can be unit-tested (tests/unit/pointStats.test.mjs) — these
 * mutate roster Player counters (totalPointsPlayed, consecutivePointsPlayed,
 * totalTimePlayed, pointsWon, pointsLost) but do no UI work, persistence, or
 * navigation, mirroring undoLogic.js.
 *
 * Era pairing (G11.1-.2 item 3): point.players entries are player NAMES on
 * legacy games but player IDS on id-era games (lines that came through
 * pendingNextLine, e.g. Nov-2025 CUDO Mixed). Matching goes through
 * buildPointMembership so id-era points finally count — and every point
 * counted that way is stamped `playerStatsCounted`, so revert knows which
 * matching did the incrementing:
 *   - marker present → membership-based decrement (symmetric with the new
 *     increment); marker cleared.
 *   - marker absent  → the point was scored under the pre-membership code:
 *     decrement by raw name, exactly what that code incremented. On an
 *     id-era legacy point that is a deliberate no-op — its score never
 *     incremented anything, and undo can chain back through every point of
 *     a reopened old game, so decrementing would corrupt career counters.
 * Historical id-era points keep their gap in these legacy live counters
 * (no backfill): accurate reporting comes from the event-derived path
 * (utils/eventStats.js), which already resolves ids.
 */
import { Role } from '../store/models.js';

/**
 * Increment per-player counters for a just-scored point and stamp the point
 * `playerStatsCounted`. Call with point.winner already set.
 * "Played" = on the line at any moment, including substituted-out players —
 * same semantics as getPlayerGameTime (utils/helpers.js).
 * @param {object} point - the scored Point (winner set)
 * @param {Array} roster - currentTeam.teamRoster Player objects
 * @param {object} membership - buildPointMembership(game) for the point's game
 */
function applyPointPlayerStats(point, roster, membership) {
    roster.forEach(player => {
        if (membership.played(point, player)) {
            player.totalPointsPlayed++;
            player.consecutivePointsPlayed++;
            player.totalTimePlayed += point.totalPointTime;
            if (point.winner === Role.TEAM) {
                player.pointsWon++;
            } else {
                player.pointsLost++;
            }
        } else {                                    // the player did not play this point
            player.consecutivePointsPlayed = 0;
        }
    });
    point.playerStatsCounted = true;
}

/**
 * Decrement the counters applyPointPlayerStats incremented, choosing the
 * matching by the point's `playerStatsCounted` marker (see file header).
 * Counters clamp at zero: chained undo across a sat-out point can otherwise
 * push consecutivePointsPlayed negative (the sat-out reset is unrecoverable).
 * Call with point.winner still set.
 */
function revertPointPlayerStats(point, roster, membership) {
    const counted = !!point.playerStatsCounted;
    roster.forEach(player => {
        const playedPoint = counted
            ? membership.played(point, player)
            : (point.players.includes(player.name) ||
                (point.substitutedOutPlayers && point.substitutedOutPlayers.includes(player.name)));
        if (playedPoint) {
            player.totalPointsPlayed--;
            if (player.totalPointsPlayed < 0) player.totalPointsPlayed = 0;
            player.consecutivePointsPlayed--;
            if (player.consecutivePointsPlayed < 0) player.consecutivePointsPlayed = 0;
            player.totalTimePlayed -= point.totalPointTime;
            if (player.totalTimePlayed < 0) player.totalTimePlayed = 0;
            if (point.winner === Role.TEAM) {
                player.pointsWon--;
                if (player.pointsWon < 0) player.pointsWon = 0;
            } else {
                player.pointsLost--;
                if (player.pointsLost < 0) player.pointsLost = 0;
            }
        }
    });
    point.playerStatsCounted = false;
}

export { applyPointPlayerStats, revertPointPlayerStats };
