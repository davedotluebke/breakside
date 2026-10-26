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
import { Role, Throw, Defense, Other } from '../store/models.js';
import { isScoringSide, pointValueOf } from '../store/scrimmageRules.js';

/** A Throw with score_flag or a Defense with Callahan_flag scored a point. */
function isScoreEvent(evt) {
    return (evt instanceof Throw && evt.score_flag) ||
        (evt instanceof Defense && evt.Callahan_flag);
}

/**
 * One pending score taken back (scrimmage variations): a conversion pending
 * is simply cleared; an unbanked Bank run loses one point and is cleared at
 * zero. A two-point score needs two taps, which the coach can see.
 */
function takeBackPendingScore(point) {
    const left = (Number(point.pendingValue) || 1) - 1;
    if (left > 0) {
        point.pendingValue = left;
    } else {
        point.pendingConversion = null;
        point.pendingValue = 0;
    }
}

/** An Other event recorded after its point ended (timeout, halftime, …). */
function isBetweenPointsEvent(evt) {
    return evt instanceof Other && !!evt.betweenPoints;
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
 *  0. Scored point whose last event was recorded AFTER it ended (a
 *     between-points timeout, halftime, switch sides or swap — flagged
 *     `betweenPoints`): pop that event alone, leaving the score in place.
 *     Between points, Undo means "undo the timeout", not "reopen the
 *     point". An emptied possession is dropped (the handlers create one
 *     to host the event when the point had none). → outcome 'event-undone'
 *  1. Scored point whose last event is NOT a scoring event ("They Score" /
 *     "Skip"): revert only the score; if the point has no possessions at
 *     all, remove the whole point. → outcome 'score-reverted'
 *  2. Active possession has events: pop the last event, revert its player
 *     stats (and the point score if it was the scoring event); if the
 *     possession is now empty, clean it up (removing the point when it was
 *     the only possession — unless the point started on offense, whose
 *     empty state is simply "pull not yet received" — else stepping back to
 *     the previous possession). → outcome 'event-undone'
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

    // ── Branch 0: the opponent scored under a conversion rule (scrimmage
    // variations) and must convert, or is on an unbanked run — their score
    // is the last thing recorded (it leaves no event), so Undo takes it back
    // (one score of the run at a time) and the point plays on.
    if (!point.winner && point.pendingConversion === Role.OPPONENT) {
        takeBackPendingScore(point);
        result.outcome = 'score-reverted';
        return result;
    }

    // ── Branch 0, between points: an event recorded after the score on the
    // finished point (timeout, halftime, …) — pop it alone
    if (point.winner && point.possessions.length > 0) {
        const lastPoss = getActivePossession(point);
        const lastEvt = lastPoss.events[lastPoss.events.length - 1];
        if (lastEvt && isBetweenPointsEvent(lastEvt)) {
            lastPoss.events.pop();
            if (lastPoss.events.length === 0) point.possessions.pop();
            result.outcome = 'event-undone';
            result.undoneEvent = lastEvt;
            return result;
        }
    }

    // ── Branch 1: scored point, but the last event isn't a scoring event —
    // revert only the score (handles "They Score" and "Skip" without event,
    // and a Bank: the bank itself left no event, so the scoring throw before
    // it stays)
    if (point.winner) {
        let hasScoreEvent = false;
        if (point.possessions.length > 0) {
            const lastPoss = getActivePossession(point);
            if (lastPoss.events.length > 0) {
                hasScoreEvent = isScoreEvent(lastPoss.events[lastPoss.events.length - 1]);
            }
        }
        if (!hasScoreEvent || point.banked) {
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
                decrementStat(undoneEvent.assist || undoneEvent.thrower, 'assists');
            }
        } else if (undoneEvent instanceof Defense) {
            // Handle Callahan: decrement defender's goals
            if (undoneEvent.Callahan_flag) {
                decrementStat(undoneEvent.defender, 'goals');
            }
        } else if (undoneEvent instanceof Other && undoneEvent.injury_flag) {
            // Injury sub: restore the pre-sub roster from the snapshots the
            // event carries (absent on legacy events recorded before the
            // snapshots existed — leave the roster alone then; the sub was
            // irreversible under the old code anyway).
            if (Array.isArray(undoneEvent.playersBefore)) {
                point.players = [...undoneEvent.playersBefore];
            }
            if (Array.isArray(undoneEvent.subbedOutBefore)) {
                point.substitutedOutPlayers = [...undoneEvent.subbedOutBefore];
            }
            if (Array.isArray(undoneEvent.subbedInBefore)) {
                point.substitutedInPlayers = [...undoneEvent.subbedInBefore];
            }
        }
        // If the undone event was a score, revert updateScore() changes
        if (point.winner && isScoreEvent(undoneEvent)) {
            revertPointScore(point);
        } else if (isScoreEvent(undoneEvent) && point.pendingConversion === Role.TEAM) {
            // Our score awaiting its conversion, or one score of our unbanked
            // run (scrimmage variations) — taken back.
            takeBackPendingScore(point);
        }

        // If the possession is now empty after undoing (e.g. pull was only
        // event), clean it up so the user isn't stranded mid-point with no
        // way forward
        if (currentPossession.events.length === 0) {
            point.possessions.pop();
            if (point.possessions.length === 0) {
                if (undoneEvent instanceof Other && undoneEvent.injury_flag) {
                    // The possession existed only to host the sub event
                    // (confirmSubstitution creates one when a Simple-mode
                    // offense point has none yet). A mid-point with zero
                    // possessions is the normal freshly-started-offense-point
                    // state — do NOT remove the live point.
                } else if (point.startingPosition === 'offense') {
                    // The point's first touch was undone — the pull catch /
                    // pickup / dropped pull the Full and Field tabs record,
                    // or a Simple-mode first throw. Same reasoning: an
                    // offensive point with no possessions is its normal
                    // just-started state (the clock re-arms, see
                    // store/pointClock.js), so a mis-tap costs one tap, not
                    // the point start. Backing out the point itself stays
                    // the empty-point Undo double-tap in gameLogic.undoEvent.
                    // A scored point reaches here with its score already
                    // reverted above, so it is live again.
                } else {
                    // No possessions left — remove the point and go to
                    // between-points. Don't decrement player point stats:
                    // updateScore() was either never called (unscored point)
                    // or already reverted by revertPointScore().
                    game.points.pop();
                    result.pointRemoved = true;
                }
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
            // Decrement game score (a no-score drill rep put nothing on it)
            if (isScoringSide(point.winner)) game.scores[point.winner] -= pointValueOf(point);
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

// =============================================================================
// Undo across point boundaries ("Undo to here" from the Log tab)
// =============================================================================
//
// A target names a position in the game's points → possessions → events
// stream; undoToTarget runs the single-step tree above until that position
// no longer exists, so every step is one the coach could have taken by hand
// and the live counters are reverted exactly as a hand-chained Undo would.
// The one thing the loop adds is backing out a started-but-empty point on
// its own (the double-tap Undo does that interactively; here the confirm
// before the batch already covered it).

/**
 * The undo target a game-log entry (utils/gameLogRenderer.js
 * buildGameLogEntries) stands for, or null when the line is not a thing
 * that can be undone (headers, the roster line, the period note, an
 * inline turnover delimiter with no possession of its own yet).
 *
 * Kinds: 'event' (this event and everything after it), 'possession'
 * (this possession's start and everything after it), 'score' (the point's
 * score — a "They Score" / Skip with no scoring event — and everything
 * after it), 'point' (the point itself, from its roster line).
 */
function targetFromEntry(entry) {
    if (!entry || entry.pointIdx == null) return null;
    switch (entry.kind) {
        case 'event':
        case 'after':
            return { kind: 'event', pointIdx: entry.pointIdx, possIdx: entry.possIdx, eventIdx: entry.eventIdx };
        case 'possession':
            if (entry.possIdx == null) return null;
            return { kind: 'possession', pointIdx: entry.pointIdx, possIdx: entry.possIdx };
        case 'score':
        case 'currentscore':
            return { kind: 'score', pointIdx: entry.pointIdx };
        case 'roster':
        case 'pullnote':
            return { kind: 'point', pointIdx: entry.pointIdx };
        default:
            return null;
    }
}

/** Does the target position still exist in the game? */
function targetPresent(game, target) {
    const point = game.points[target.pointIdx];
    if (!point) return false;
    switch (target.kind) {
        case 'point': return true;
        case 'score': return !!point.winner;
        case 'possession': return point.possessions.length > target.possIdx;
        case 'event': {
            const poss = point.possessions[target.possIdx];
            return !!poss && poss.events.length > target.eventIdx;
        }
        default: return false;
    }
}

/**
 * Undo single steps until `target` is gone. Mutates the game like
 * applyUndoToGame (same deps), no UI.
 *
 * @returns {{done: boolean, steps: number, eventsUndone: number,
 *            pointsRemoved: number, targetPointReopened: boolean,
 *            removedEvents: object[]}}
 *   done=false means the loop stalled before reaching the target (a
 *   malformed game); the caller should treat the game as changed anyway.
 *   targetPointReopened: the target's point was scored and survives, live.
 */
function undoToTarget(game, target, deps, { maxSteps = 5000 } = {}) {
    const summary = {
        done: false, steps: 0, eventsUndone: 0, pointsRemoved: 0,
        targetPointReopened: false, removedEvents: [],
    };
    if (!game || !target || !targetPresent(game, target)) { summary.done = true; return summary; }
    const targetPoint = game.points[target.pointIdx];
    const targetWasScored = !!targetPoint.winner;

    while (summary.steps < maxSteps) {
        if (!targetPresent(game, target)) { summary.done = true; break; }
        const pointsBefore = game.points.length;
        const r = applyUndoToGame(game, deps);
        summary.steps++;
        if (r.outcome === 'none') {
            // A started point with nothing recorded: back it out, as the
            // Undo double-tap would.
            const last = game.points[game.points.length - 1];
            if (last && !last.winner && last.possessions.length === 0) {
                game.points.pop();
                summary.pointsRemoved++;
                continue;
            }
            break;   // stalled
        }
        if (r.outcome === 'event-undone') {
            summary.eventsUndone++;
            summary.removedEvents.push(r.undoneEvent);
        } else if (r.outcome === 'score-reverted') {
            summary.eventsUndone++;   // a "They Score" is one log line, one step
        }
        if (game.points.length < pointsBefore) summary.pointsRemoved++;
    }
    summary.targetPointReopened = summary.done && targetWasScored
        && game.points.length > target.pointIdx && !game.points[target.pointIdx].winner;
    return summary;
}

/**
 * A throwaway copy of the game that applyUndoToGame can walk without
 * touching real state: events keep their prototypes (the tree checks
 * instanceof) but their player references become scratch objects, and the
 * score/points arrays are copied. Deep enough for counting, nothing more.
 */
function cloneForSimulation(game) {
    const PLAYER_FIELDS = ['thrower', 'receiver', 'defender', 'puller', 'assist', 'hockeyAssist'];
    const cloneEvent = e => {
        const c = Object.assign(Object.create(Object.getPrototypeOf(e)), e);
        PLAYER_FIELDS.forEach(f => { if (c[f]) c[f] = {}; });
        return c;
    };
    const clonePossession = p => Object.assign({}, p, { events: (p.events || []).map(cloneEvent) });
    const clonePoint = pt => Object.assign({}, pt, {
        possessions: (pt.possessions || []).map(clonePossession),
        players: [...(pt.players || [])],
        substitutedOutPlayers: [...(pt.substitutedOutPlayers || [])],
        substitutedInPlayers: [...(pt.substitutedInPlayers || [])],
    });
    return {
        points: (game.points || []).map(clonePoint),
        scores: Object.assign({}, game.scores),
    };
}

/**
 * What undoToTarget would do, without doing it: the same loop on a
 * simulation clone. For the confirm text.
 */
function describeUndoTo(game, target) {
    const sim = cloneForSimulation(game);
    return undoToTarget(sim, target, {
        getActivePossession: point => point.possessions[point.possessions.length - 1],
        resolvePlayer: () => null,
        revertPointScore: point => {
            if (isScoringSide(point.winner)) sim.scores[point.winner] -= pointValueOf(point);
            point.winner = '';
        },
    });
}

export { applyUndoToGame, targetFromEntry, targetPresent, undoToTarget, describeUndoTo, isBetweenPointsEvent };
