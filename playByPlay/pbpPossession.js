/*
 * Shared play-by-play possession core.
 *
 * The Full PBP tab (playByPlay/fullPbp.js) and the Field PBP tab
 * (playByPlay/fieldPbp.js) are two different *input surfaces* over the same
 * underlying game state. This module holds the logic they must agree on so the
 * two tabs can never drift apart:
 *
 *   - reconstructState(): derive (mode, holder) from the current point's
 *     event stream — the single source of truth for "are we on O or D, and
 *     who has the disc".
 *   - findLastEditableEvent(): the most recent Throw/Turnover/Defense, used by
 *     the modifier strip ("Last throw was a:").
 *   - createThrow / createTurnover / createDefense / createPull: append a real
 *     event to the current point, update stats, advance the score/point where
 *     appropriate, persist, and publish on the narration event bus.
 *
 * These functions are intentionally free of any tab-specific UI state (no
 * manualHolder, no breakArmed, no render()). Callers pass the values they need
 * as arguments and re-render themselves; every mutation publishes `eventAdded`
 * on the bus, so any subscribed tab repaints regardless of who made the edit.
 *
 * Extracted from fullPbp.js (which now delegates here) so behavior is shared,
 * not duplicated.
 */

import {
    Throw, Turnover, Defense, Pull, Role, UNKNOWN_PLAYER,
} from '../store/models.js';
import { saveAllTeamsData } from '../store/storage.js';
import { getLatestPoint, getPlayerFromName } from '../utils/helpers.js';
import { logEvent } from '../ui/eventLogDisplay.js';
import { updateScore } from '../game/gameLogic.js';
import { moveToNextPoint } from '../game/pointManagement.js';
import { ensurePossessionExists } from './keyPlayDialog.js';

const pbpPossession = (function() {
    // -----------------------------------------------------------------
    // State reconstruction — derive (mode, holder) from the event stream.
    // Last-event-wins; we trust event semantics over possession.offensive
    // because possession boundaries can lag a turnover by one event.
    // -----------------------------------------------------------------
    function reconstructState() {
        const point = (typeof getLatestPoint === 'function') ? getLatestPoint() : null;
        if (!point) {
            return { mode: 'offense', holder: null, point: null };
        }

        let mode = (point.startingPosition === 'defense') ? 'defense' : 'offense';
        let holder = null;

        // Scan backward for the last MODE-BEARING event, skipping annotation
        // events (Other: injury sub / timeout / switch sides, Violation) —
        // they carry no possession semantics. Stopping at the raw last event
        // used to reset mode to the point's startingPosition whenever an
        // injury sub was the most recent thing recorded, flipping the
        // Full/Field O&D surface mid-point.
        let lastEvent = null;
        outer:
        for (let i = (point.possessions || []).length - 1; i >= 0; i--) {
            const events = point.possessions[i].events;
            if (!events) continue;
            for (let j = events.length - 1; j >= 0; j--) {
                const e = events[j];
                if (e.type === 'Other' || e.type === 'Violation') continue;
                lastEvent = e;
                break outer;
            }
        }

        if (lastEvent) {
            if (lastEvent.type === 'Throw') {
                if (!lastEvent.score_flag) {
                    mode = 'offense';
                    holder = lastEvent.receiver || null;
                }
            } else if (lastEvent.type === 'Turnover') {
                mode = 'defense';
                holder = null;
            } else if (lastEvent.type === 'Defense') {
                if (lastEvent.Callahan_flag) {
                    // Point ended; fall back to mode default.
                } else {
                    mode = 'offense';
                    holder = lastEvent.interception_flag ? (lastEvent.defender || null) : null;
                }
            } else if (lastEvent.type === 'Pull') {
                // After our pull, the opponent receives → we are on defense,
                // no holder of ours.
                mode = 'defense';
                holder = null;
            }
            // (Violation / Other never reach here — the scan above skips them.)
        }

        return { mode, holder, point };
    }

    /**
     * Most recent Throw / Turnover / Defense in the point (for the modifier
     * strip). Turnover is included so a throwaway amends the turnover, not the
     * preceding completed throw.
     */
    function findLastEditableEvent(point) {
        if (!point || !point.possessions) return null;
        for (let i = point.possessions.length - 1; i >= 0; i--) {
            const events = point.possessions[i].events;
            if (!events) continue;
            for (let j = events.length - 1; j >= 0; j--) {
                const e = events[j];
                if (e.type === 'Throw' || e.type === 'Turnover' || e.type === 'Defense') return e;
            }
        }
        return null;
    }

    function getUnknown() {
        return (typeof getPlayerFromName === 'function')
            ? getPlayerFromName(UNKNOWN_PLAYER)
            : null;
    }

    function publishAdded(evt, source) {
        if (!window.narrationEventBus) return;
        window.narrationEventBus.publish('eventAdded', {
            event: evt,
            source: source || 'manual',
            provisionalId: null
        });
    }

    function persist() {
        if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
    }

    // -----------------------------------------------------------------
    // Event creation. Each appends to the current point, updates stats,
    // logs, publishes, persists, and returns the created event (or null if
    // it couldn't be created). Callers handle their own UI state + render.
    // -----------------------------------------------------------------

    /**
     * @param thrower Player, @param receiver Player
     * @param opts {score, breakmark, huck, reset, swing, hammer, sky, layout,
     *              from, to, assist}
     */
    function createThrow(thrower, receiver, opts) {
        opts = opts || {};
        if (typeof ensurePossessionExists !== 'function') return null;
        if (!thrower || !receiver) return null;

        const evt = new Throw({
            thrower, receiver,
            huck: !!opts.huck,
            breakmark: !!opts.breakmark,
            reset: !!opts.reset,
            swing: !!opts.swing,
            hammer: !!opts.hammer,
            sky: !!opts.sky,
            layout: !!opts.layout,
            score: !!opts.score,
            from: opts.from || null,
            to: opts.to || null,
            assist: opts.assist || null
        });
        const possession = ensurePossessionExists(true);
        possession.addEvent(evt);

        // Stats: every throw is a completed pass; a score adds an assist for
        // the (explicit) assist holder and a goal for the receiver.
        if (typeof thrower.completedPasses !== 'number') thrower.completedPasses = 0;
        thrower.completedPasses += 1;
        if (evt.score_flag) {
            const assistPlayer = evt.assist || thrower;
            if (assistPlayer) assistPlayer.assists = (assistPlayer.assists || 0) + 1;
            receiver.goals = (receiver.goals || 0) + 1;
        }

        if (typeof logEvent === 'function') logEvent(evt.summarize());
        publishAdded(evt, opts.source);

        if (evt.score_flag && typeof updateScore === 'function' && typeof Role !== 'undefined') {
            updateScore(Role.TEAM);
            if (typeof moveToNextPoint === 'function') moveToNextPoint();
        }

        persist();
        return evt;
    }

    /**
     * @param opts {throwaway, drop, goodDefense, stall, huck, from, to, inferred}
     */
    function createTurnover(thrower, receiver, opts) {
        opts = opts || {};
        if (typeof ensurePossessionExists !== 'function') return null;

        const evt = new Turnover({
            thrower: thrower || null,
            receiver: receiver || null,
            throwaway: !!opts.throwaway,
            huck: !!opts.huck,
            receiverError: !!opts.drop,
            goodDefense: !!opts.goodDefense,
            stall: !!opts.stall,
            from: opts.from || null,
            to: opts.to || null
        });
        if (opts.inferred) evt.inferred_flag = true;

        // Turnovers live in the offensive possession that just ended.
        const possession = ensurePossessionExists(true);
        possession.addEvent(evt);

        if (typeof logEvent === 'function') logEvent(evt.summarize());
        publishAdded(evt, opts.source);

        persist();
        return evt;
    }

    /**
     * @param defender Player|null (null = unforced opponent error)
     * @param opts {block, interception, Callahan, stall, unforcedError,
     *              layout, sky, to, inferred}
     */
    function createDefense(defender, opts) {
        opts = opts || {};
        if (typeof ensurePossessionExists !== 'function') return null;
        if (!defender && !opts.unforcedError) return null;

        const evt = new Defense({
            defender: defender || null,
            block: !!opts.block,
            interception: !!opts.interception,
            layout: !!opts.layout,
            sky: !!opts.sky,
            Callahan: !!opts.Callahan,
            stall: !!opts.stall,
            unforcedError: !!opts.unforcedError,
            to: opts.to || null
        });
        if (opts.inferred) evt.inferred_flag = true;

        const possession = ensurePossessionExists(false);
        possession.addEvent(evt);

        if (typeof logEvent === 'function') logEvent(evt.summarize());
        publishAdded(evt, opts.source);

        if (evt.Callahan_flag && typeof updateScore === 'function' && typeof Role !== 'undefined') {
            if (defender) defender.goals = (defender.goals || 0) + 1;
            updateScore(Role.TEAM);
            if (typeof moveToNextPoint === 'function') moveToNextPoint();
        }

        persist();
        return evt;
    }

    /**
     * Record a pull. Lives in a defensive possession (we just pulled; the
     * opponent now has the disc). Does NOT change score or advance the point.
     * @param puller Player|null
     * @param opts {from, to, hang, brick, roller, io, oi, flick, quality}
     */
    function createPull(puller, opts) {
        opts = opts || {};
        if (typeof ensurePossessionExists !== 'function') return null;

        const evt = new Pull({
            puller: puller || null,
            quality: opts.quality || null,
            flick: !!opts.flick,
            roller: !!opts.roller,
            io: !!opts.io,
            oi: !!opts.oi,
            from: opts.from || null,
            to: opts.to || null,
            hang: (typeof opts.hang === 'number') ? opts.hang : null,
            brick: !!opts.brick
        });

        const possession = ensurePossessionExists(false);
        possession.addEvent(evt);

        if (typeof logEvent === 'function') logEvent(evt.summarize());
        publishAdded(evt, opts.source);

        persist();
        return evt;
    }

    // -----------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------
    return {
        reconstructState,
        findLastEditableEvent,
        getUnknown,
        publishAdded,
        createThrow,
        createTurnover,
        createDefense,
        createPull
    };
})();

// --- ES-module export ---
export { pbpPossession };
// window survivor: late-bound back-edge hook (namespace called window-qualified
// by playByPlay/scoreAttribution.js, keyPlayDialog.js, fullPbp.js, fieldPbp.js)
window.pbpPossession = pbpPossession;
