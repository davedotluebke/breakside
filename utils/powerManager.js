/*
 * Power manager — the app's single owner of `document.visibilityState`.
 *
 * Before this module every recurring loop in the app ran regardless of whether
 * the page was visible: two network pings on a 2–3s cadence during a game, a
 * 5×/sec narration phase poll and a 2×/sec mic-button poll that ran for the
 * entire lifetime of the tab, and a handful of 1s display timers. Nothing was
 * gated on visibility; the one `visibilitychange` listener in the app
 * (game/controllerState.js) is resume-side recovery and returns early unless
 * the page is already visible.
 *
 * This module watches visibility and game-screen entry/exit, runs the pure
 * rules in utils/powerPolicy.js, and broadcasts the resulting plan as a DOM
 * CustomEvent. Each loop's owning module listens for its own flag:
 *
 *     document.addEventListener('breakside:power-plan', (e) => {
 *         if (e.detail.plan.autoSync) startAutoSync(); else stopAutoSync();
 *     });
 *
 * A CustomEvent rather than a registry because the listeners live at every
 * layer — store/sync.js (data) through ui/ — and a data-layer module cannot
 * import upward into utils/ (ARCHITECTURE.md § Module Loading). The event
 * carries the whole plan so a listener that missed an edge still converges.
 *
 * This module also owns the shared base tick that *drives* the out-of-game
 * polls (`breakside:power-tick`). The plan says whether a loop may run; the
 * tick says when. Keeping both here is what makes same-cadence loops fire in
 * the same moment instead of at four unrelated offsets — see TICK_DRIVEN_LOOPS
 * in powerPolicy.js for why that matters more than the request count does.
 */
import {
    loopPlan, diffPlan, LOOPS,
    TICK_DRIVEN_LOOPS, loopPeriods, tickSchedule, loopsDueOnTick,
} from './powerPolicy.js';
import { log } from './logger.js';

const powerManager = (function() {
    const EVENT_NAME = 'breakside:power-plan';
    const TICK_EVENT_NAME = 'breakside:power-tick';

    // The context powerPolicy consumes. `inGame` is pushed in by
    // game/gameScreenSync.js's enterGameScreen/exitGameScreen.
    const ctx = {
        visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
        inGame: false
    };

    let lastPlan = null;

    // ─── Shared base tick ───────────────────────────────────────────────────
    //
    // The out-of-game polls used to install their own intervals whenever their
    // modules happened to start, so their phases scattered and each one woke
    // the radio at its own unrelated moment. They now ride a single tick here:
    // same-period loops land on the same tick, share one radio tail, and —
    // being same-origin — share the HTTP/2 connection too.
    //
    // powerManager owns it because it already owns the plan and the visibility
    // listener; a second scheduler would be a second source of truth about
    // what is allowed to run.

    let tickIntervalId = null;
    let tickEpoch = 0;
    let schedule = null;
    let lastRunIndex = {};

    /** Whether any tick-driven loop is supposed to be running right now. */
    function anyTickLoopPlanned(plan) {
        return TICK_DRIVEN_LOOPS.some(loop => !!plan[loop]);
    }

    /**
     * The user's Cloud refresh interval, read late-bound: settings/ evaluates
     * above utils/ and cannot be imported from here (§ Module Loading).
     */
    function refreshIntervalMs() {
        return window.advancedSettings?.getRefreshIntervalMs?.();
    }

    function onTick() {
        // Derive the index from the clock rather than counting callbacks, so a
        // throttled tab that fires late doesn't drift the whole schedule.
        const tickIndex = Math.max(0, Math.round((Date.now() - tickEpoch) / schedule.baseMs));
        const result = loopsDueOnTick(tickIndex, schedule, lastRunIndex);
        lastRunIndex = result.lastRunIndex;
        if (!result.due.length) return;

        document.dispatchEvent(new CustomEvent(TICK_EVENT_NAME, {
            detail: { due: result.due, tickIndex }
        }));
    }

    function startTick() {
        const periods = loopPeriods({ refreshIntervalMs: refreshIntervalMs() });
        const next = tickSchedule(periods);

        // Nothing to do if the cadence is unchanged and we're already ticking.
        if (tickIntervalId && schedule && schedule.baseMs === next.baseMs) {
            schedule = next;
            return;
        }

        stopTick();
        schedule = next;
        // The device's own epoch, not the wall clock: aligning every client to
        // :00 and :10 would hand the server a thundering herd.
        tickEpoch = Date.now();
        lastRunIndex = {};
        tickIntervalId = setInterval(onTick, schedule.baseMs);
        log(`🔋 power tick: ${schedule.baseMs}ms base`);
    }

    function stopTick() {
        if (!tickIntervalId) return;
        clearInterval(tickIntervalId);
        tickIntervalId = null;
    }

    /**
     * Recompute the plan and broadcast it if anything changed.
     * @param {string} reason - what triggered this (for the log line)
     * @param {boolean} [force] - broadcast even when nothing changed
     */
    function publishPlan(reason, force) {
        const plan = loopPlan(ctx);
        const changed = diffPlan(lastPlan, plan);
        if (!force && !changed.start.length && !changed.stop.length) return;

        lastPlan = plan;
        if (changed.start.length || changed.stop.length) {
            log(`🔋 power (${reason}): ` +
                `${changed.start.length ? '+' + changed.start.join(',') + ' ' : ''}` +
                `${changed.stop.length ? '-' + changed.stop.join(',') : ''}`);
        }
        document.dispatchEvent(new CustomEvent(EVENT_NAME, {
            detail: {
                plan,
                start: changed.start,
                stop: changed.stop,
                reason,
                // Copy, not the live object — a listener must not be able to
                // mutate the manager's context.
                ctx: { visible: ctx.visible, inGame: ctx.inGame }
            }
        }));

        // Listeners have set their own running flags off the plan above, so
        // the tick's only job is to exist when at least one of them wants it.
        // Ticking with nothing subscribed would be a wakeup for no one.
        if (anyTickLoopPlanned(plan)) startTick();
        else stopTick();
    }

    function handleVisibilityChange() {
        const visible = document.visibilityState !== 'hidden';
        if (visible === ctx.visible) return;
        ctx.visible = visible;
        publishPlan(visible ? 'visible' : 'hidden');
    }

    /**
     * Called by game/gameScreenSync.js on enterGameScreen / exitGameScreen.
     * @param {boolean} inGame
     */
    function setGameActive(inGame) {
        const next = !!inGame;
        if (next === ctx.inGame) return;
        ctx.inGame = next;
        publishPlan(next ? 'game-enter' : 'game-exit');
    }

    /** Current context snapshot (read-only copy). */
    function getContext() {
        return { visible: ctx.visible, inGame: ctx.inGame };
    }

    /** Whether the page is visible right now. */
    function isVisible() {
        return ctx.visible;
    }

    function init() {
        document.addEventListener('visibilitychange', handleVisibilityChange);
        // First broadcast happens after every module has evaluated and
        // registered its listener. Modules are deferred, so they all finish
        // before DOMContentLoaded fires. `force` so listeners get the initial
        // state even when it matches the (empty) baseline — this is what makes
        // a cold start in a hidden tab behave correctly.
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => publishPlan('init', true));
        } else {
            publishPlan('init', true);
        }
    }

    init();

    return { setGameActive, getContext, isVisible, LOOPS, EVENT_NAME, TICK_EVENT_NAME };
})();

// --- ES-module export ---
export { powerManager };
// window survivor: late-bound state accessor (read window-qualified by
// store/sync.js and teams/activeGamePolling.js, which sit at or below this
// module's layer and cannot import upward)
window.powerManager = powerManager;
