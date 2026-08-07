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
 */
import { loopPlan, diffPlan, LOOPS } from './powerPolicy.js';
import { log } from './logger.js';

const powerManager = (function() {
    const EVENT_NAME = 'breakside:power-plan';

    // The context powerPolicy consumes. `inGame` is pushed in by
    // game/gameScreenSync.js's enterGameScreen/exitGameScreen.
    const ctx = {
        visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
        inGame: false
    };

    let lastPlan = null;

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

    return { setGameActive, getContext, isVisible, LOOPS, EVENT_NAME };
})();

// --- ES-module export ---
export { powerManager };
// window survivor: late-bound state accessor (read window-qualified by
// store/sync.js and teams/activeGamePolling.js, which sit at or below this
// module's layer and cannot import upward)
window.powerManager = powerManager;
