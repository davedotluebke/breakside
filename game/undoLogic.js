/*
 * Undo decision tree, extracted from gameLogic.undoEvent (F3 cleanup) so it
 * can be unit-tested (tests/unit/undoLogic.test.mjs pins the behavior).
 *
 * applyUndoToGame mutates the passed game's points / possessions / player
 * stat objects, but performs NO UI work, no persistence, and no navigation —
 * the caller (gameLogic.undoEvent) acts on the returned descriptor.
 * Everything that reaches outside the game object is injected via `deps`:
 *   - getActivePossession(point): the current (last) possession
 *   - resolvePlayer(name): Player object for a roster name
 *   - revertPointScore(point): undo updateScore()'s effects for a scored
 *     point (game score, per-player point stats, point winner/timestamps)
 */
import { Role, Throw, Defense } from '../store/models.js';

/** A Throw with score_flag or a Defense with Callahan_flag scored a point. */
function isScoreEvent(evt) {
    return (evt instanceof Throw && evt.score_flag) ||
        (evt instanceof Defense && evt.Callahan_flag);
}

/** Decrement a stat, clamping at zero. */
function decrementStat(obj, field) {
    if (!obj) return;
    obj[field] = (obj[field] || 0) - 1;
    if (obj[field] < 0) obj[field] = 0;
}

/**
 * Undo the most recent event of the game's latest point.
 *
 * Branches (in order):
 *  1. Scored point whose last event is NOT a scoring event ("They Score" /
 *     "Skip"): revert only the score; if the point has no possessions at
 *     all, remove the whole point. → outcome 'score-reverted'
 *  2. Active possession has events: pop the last event, revert its player
 *     stats (and the point score if it was the scoring event); if the
 *     possession is now empty, clean it up (removing the point when it was
 *     the only possession, else stepping back to the previous possession).
 *     → outcome 'event-undone'
 *  3. Active possession has no events: pop it; if the point has no
 *     possessions left, revert player point stats / game score (only if the
 *     point was scored) and remove the point, else step back to the
 *     previous possession. → outcome 'possession-popped'
 *  4. Nothing to do (no points, or a point with no possessions).
 *     → outcome 'none'
 *
 * @returns {{outcome: 'score-reverted'|'event-undone'|'possession-popped'|'none',
 *            pointRemoved: boolean, undoneEvent: object|null}}
 */
function applyUndoToGame(game, deps) {
    const { getActivePossession, resolvePlayer, revertPointScore } = deps;
    const result = { outcome: 'none', pointRemoved: false, undoneEvent: null };

    if (!game || game.points.length === 0) return result;
    const point = game.points[game.points.length - 1];

    // ── Branch 1: scored point, but the last event isn't a scoring event —
    // revert only the score (handles "They Score" and "Skip" without event)
    if (point.winner) {
        let hasScoreEvent = false;
        if (point.possessions.length > 0) {
            const lastPoss = getActivePossession(point);
            if (lastPoss.events.length > 0) {
                hasScoreEvent = isScoreEvent(lastPoss.events[lastPoss.events.length - 1]);
            }
        }
        if (!hasScoreEvent) {
            revertPointScore(point);
            // If the point has no possessions (e.g. "They Score" with no
            // prior events), remove the entire point and go between-points
            if (point.possessions.length === 0) {
                game.points.pop();
                result.pointRemoved = true;
            }
            result.outcome = 'score-reverted';
            return result;
        }
    }

    if (point.possessions.length === 0) return result;

    let currentPossession = getActivePossession(point);
    if (currentPossession.events.length > 0) {
        // ── Branch 2: pop the last event and revert its stats
        const undoneEvent = currentPossession.events.pop();
        result.outcome = 'event-undone';
        result.undoneEvent = undoneEvent;

        if (undoneEvent instanceof Throw) {
            decrementStat(undoneEvent.thrower, 'completedPasses');
            if (undoneEvent.score_flag) {
                decrementStat(undoneEvent.receiver, 'goals');
                decrementStat(undoneEvent.thrower, 'assists');
            }
        } else if (undoneEvent instanceof Defense) {
            // Handle Callahan: decrement defender's goals
            if (undoneEvent.Callahan_flag) {
                decrementStat(undoneEvent.defender, 'goals');
            }
        }
        // If the undone event was a score, revert updateScore() changes
        if (point.winner && isScoreEvent(undoneEvent)) {
            revertPointScore(point);
        }

        // If the possession is now empty after undoing (e.g. pull was only
        // event), clean it up so the user isn't stranded mid-point with no
        // way forward
        if (currentPossession.events.length === 0) {
            point.possessions.pop();
            if (point.possessions.length === 0) {
                // No possessions left — remove the point and go to
                // between-points. Don't decrement player point stats:
                // updateScore() was either never called (unscored point) or
                // already reverted by revertPointScore().
                game.points.pop();
                result.pointRemoved = true;
            } else {
                // Go back to previous possession
                currentPossession = getActivePossession(point);
                currentPossession.endTimestamp = null;
            }
        }
        return result;
    }

    // ── Branch 3: no events in this possession — remove the possession
    point.possessions.pop();
    result.outcome = 'possession-popped';
    if (point.possessions.length === 0) {
        // No possessions left in this point — remove the point. Only revert
        // player point stats / game score if this point was actually scored:
        // updateScore() only increments those on a score, so an unscored
        // point being undone here was never counted (decrementing it would
        // corrupt earlier points' stats). Mirrors revertPointScore() and the
        // parallel branch above.
        if (point.winner) {
            point.players.forEach(playerName => {
                const player = resolvePlayer(playerName);
                if (!player) return;
                player.totalPointsPlayed--;
                player.consecutivePointsPlayed--;
                // Decrement time played for this point
                if (point.totalPointTime) {
                    player.totalTimePlayed -= point.totalPointTime;
                    if (player.totalTimePlayed < 0) player.totalTimePlayed = 0;
                }
                // Decrement pointsWon or pointsLost based on winner
                if (point.winner === Role.TEAM) {
                    decrementStat(player, 'pointsWon');
                } else if (point.winner === Role.OPPONENT) {
                    decrementStat(player, 'pointsLost');
                }
            });
            // Decrement game score
            game.scores[point.winner]--;
        }
        game.points.pop();
        result.pointRemoved = true;
    } else {
        // Restore state for previous possession
        currentPossession = getActivePossession(point);
        currentPossession.endTimestamp = null;
    }
    return result;
}

export { applyUndoToGame };
