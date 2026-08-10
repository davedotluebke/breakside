/*
 * Power policy — pure decisions about what the app should be doing right now.
 *
 * This is a pure leaf module: no DOM, no timers, no imports, no side effects.
 * It exists so the "what runs when" rules are stated once, in a form that can
 * be unit-tested directly (tests/unit/powerPolicy.test.mjs), instead of being
 * scattered across a dozen setInterval sites.
 *
 * The runtime half lives in utils/powerManager.js, which owns the app's single
 * `visibilitychange` listener, feeds a context in here, and broadcasts the
 * resulting plan as a DOM CustomEvent.
 *
 * Deliberately NOT modeled here: `online` and `authenticated`. Both change
 * asynchronously without notifying powerManager, and every loop that cares
 * already re-checks them inside its own callback (store/sync.js,
 * teams/activeGamePolling.js). Duplicating them in the policy would create a
 * second, staler source of truth for no benefit.
 */

/**
 * Stable identifiers for the app's recurring loops. The string values are the
 * keys carried in the `breakside:power-plan` event detail, so each loop's
 * owning module reads its own flag without importing anything.
 */
export const LOOPS = Object.freeze({
    /** game/controllerState.js — multi-coach role ping (network) */
    CONTROLLER_PING: 'controllerPing',
    /** game/gameScreenSync.js — pulls game state / pending line (network) */
    GAME_STATE_REFRESH: 'gameStateRefresh',
    /** game/gameTimer.js — header timer + Line-tab time cells (display only) */
    GAME_TIMER: 'gameTimer',
    /** teams/activeGamePolling.js — team-screen silent refresh (network) */
    TEAM_AUTO_REFRESH: 'teamAutoRefresh',
    /** store/sync.js — background team/player sync (network) */
    AUTO_SYNC: 'autoSync',
    /** teams/activeGamePolling.js — "another coach started a game" (network) */
    ACTIVE_GAME_POLL: 'activeGamePoll',
    /** teams/rosterManagement.js — roster cross-device sync (network) */
    ROSTER_POLL: 'rosterPoll'
});

const ALL_LOOPS = Object.freeze(Object.values(LOOPS));

/**
 * The loops driven by the shared base tick rather than by their own
 * `setInterval`.
 *
 * All four are out-of-game network polls on comparable cadences. Left to
 * themselves each installs its interval whenever its module happens to start,
 * so their phases scatter and the radio gets poked at unrelated moments —
 * which is what actually costs battery. After a request the radio sits in a
 * high-power state for seconds before dropping to idle, so the bill tracks how
 * many separate times you woke it, not how many bytes you sent. Three requests
 * in the same tick share one tail; three spread across ten seconds pay three.
 *
 * The in-game loops are deliberately absent. The 1s display timer sends
 * nothing, and after the change-stamp gate (POLLING_OPTIMIZATION.md F1) the
 * only in-game network loop left is the 2s controller ping — there is nothing
 * for it to align *with*.
 */
export const TICK_DRIVEN_LOOPS = Object.freeze([
    LOOPS.TEAM_AUTO_REFRESH,
    LOOPS.AUTO_SYNC,
    LOOPS.ROSTER_POLL,
    LOOPS.ACTIVE_GAME_POLL
]);

/** "Another coach started a game" cadence (was teams/activeGamePolling.js). */
export const ACTIVE_GAME_POLL_MS = 30000;
/** Fallback when the Cloud refresh interval setting is unreadable. */
export const DEFAULT_REFRESH_MS = 10000;

/**
 * How often each tick-driven loop wants to run.
 *
 * Three follow the user's "Cloud refresh interval" setting (Advanced Settings,
 * clamped 3–120s there), exactly as their own `setInterval` calls did. Only
 * the active-game poll is fixed: it's a background "someone else started a
 * game" notification rather than a data refresh, so it shouldn't speed up or
 * slow down with a sync preference.
 *
 * @param {object} [ctx]
 * @param {number} [ctx.refreshIntervalMs] - advancedSettings.getRefreshIntervalMs()
 * @returns {Object<string, number>} loop id -> desired period in ms
 */
export function loopPeriods(ctx) {
    const raw = ctx && ctx.refreshIntervalMs;
    const refresh = (Number.isFinite(raw) && raw > 0) ? raw : DEFAULT_REFRESH_MS;

    return {
        [LOOPS.TEAM_AUTO_REFRESH]: refresh,
        [LOOPS.AUTO_SYNC]: refresh,
        [LOOPS.ROSTER_POLL]: refresh,
        [LOOPS.ACTIVE_GAME_POLL]: ACTIVE_GAME_POLL_MS
    };
}

/**
 * Turn desired periods into one base tick plus a per-loop multiple.
 *
 * The base is the *shortest* period rather than the greatest common divisor.
 * A GCD would be exact, but a coach who sets the refresh interval to 7s would
 * produce gcd(7000, 30000) = 1000 — a 1-second tick, ten times the timer
 * wakeups we have today, to serve loops that wanted 7 and 30 seconds. Taking
 * the minimum guarantees we never tick faster than the fastest loop already
 * ticked. It also self-corrects at the other extreme: at a 120s refresh the
 * base becomes the 30s active-game poll, so that notification doesn't get
 * dragged out to two minutes.
 *
 * Each loop's multiple then rounds *up* (`ceil`), so a period that isn't a
 * clean multiple of the base runs slightly slower than asked, never faster.
 * Erring the other way would mean quietly polling the API harder than the
 * user's own setting allows.
 *
 * At the defaults this is exactly today's behavior: base 10s, the three 10s
 * loops every tick, the 30s poll every third.
 *
 * @param {Object<string, number>} periods
 * @returns {{baseMs: number, everyNTicks: Object<string, number>}}
 */
export function tickSchedule(periods) {
    const values = Object.values(periods || {}).filter(n => Number.isFinite(n) && n > 0);
    const baseMs = values.length ? Math.min(...values) : DEFAULT_REFRESH_MS;

    const everyNTicks = {};
    Object.keys(periods || {}).forEach(loop => {
        const ms = periods[loop];
        everyNTicks[loop] = (Number.isFinite(ms) && ms > 0)
            ? Math.max(1, Math.ceil(ms / baseMs))
            : 1;
    });

    return { baseMs, everyNTicks };
}

/**
 * Which loops are due on a given tick, and the bookkeeping to carry forward.
 *
 * Due-ness is "at least N ticks since this loop last ran" rather than
 * `tickIndex % N === 0`. Both keep same-period loops firing together — which
 * is the entire point — but the modulo form silently *skips* a loop whenever
 * its multiple lands on a tick the browser throttled away, and a backgrounded
 * phone throttles plenty. This form catches up on the next tick instead.
 *
 * Ticks are counted from the device's own start epoch, deliberately not from
 * the wall clock: aligning every client in the world to :00 and :10 would hand
 * the server a thundering herd.
 *
 * @param {number} tickIndex - ticks elapsed since the epoch
 * @param {{everyNTicks: Object<string, number>}} schedule
 * @param {Object<string, number>} lastRunIndex - loop id -> tick it last ran on
 * @returns {{due: string[], lastRunIndex: Object<string, number>}}
 */
export function loopsDueOnTick(tickIndex, schedule, lastRunIndex) {
    const everyN = (schedule && schedule.everyNTicks) || {};
    const prev = lastRunIndex || {};
    const due = [];
    const next = { ...prev };

    Object.keys(everyN).forEach(loop => {
        const n = everyN[loop] || 1;
        const last = Number.isFinite(prev[loop]) ? prev[loop] : -Infinity;
        if (tickIndex - last >= n) {
            due.push(loop);
            next[loop] = tickIndex;
        }
    });

    return { due: due.sort(), lastRunIndex: next };
}

/**
 * Which loops should be running, given the current context.
 *
 * The governing rule is that nothing recurring runs while the page is hidden.
 * Browsers already throttle hidden tabs, but throttling is a per-platform
 * heuristic that still lets network requests through when the tab is merely
 * backgrounded (screen on, coach in another app) — this makes the intent
 * explicit and uniform.
 *
 * @param {object} ctx
 * @param {boolean} ctx.visible - document.visibilityState === 'visible'
 * @param {boolean} ctx.inGame  - the game screen is mounted
 * @returns {Object<string, boolean>} loop id -> should it be running
 */
export function loopPlan(ctx) {
    const visible = !!(ctx && ctx.visible);
    const inGame = !!(ctx && ctx.inGame);

    return {
        // In-game loops. Two of these are network pings on a 2–3s cadence;
        // they are the reason a pocketed Line Coach's phone stays warm.
        [LOOPS.CONTROLLER_PING]: visible && inGame,
        [LOOPS.GAME_STATE_REFRESH]: visible && inGame,
        [LOOPS.GAME_TIMER]: visible && inGame,

        // Out-of-game loops. Both are stopped on game entry today
        // (enterGameScreen -> stopActiveGamePolling), so `!inGame` preserves
        // the existing behavior and adds the visibility gate.
        [LOOPS.TEAM_AUTO_REFRESH]: visible && !inGame,
        [LOOPS.ACTIVE_GAME_POLL]: visible && !inGame,

        // Self-stops when the roster screen is hidden, but nothing stopped it
        // for a coach who left that screen up and pocketed the phone.
        [LOOPS.ROSTER_POLL]: visible && !inGame,

        // Auto-sync is deliberately NOT gated on `inGame`: it already skips
        // its own body while a game is live, and that in-callback guard also
        // covers the "game just ended but we're still on the game screen"
        // window, where syncing is exactly what we want.
        [LOOPS.AUTO_SYNC]: visible
    };
}

/**
 * The loops that changed between two plans, split into what to start and what
 * to stop. `prev` may be null for the first plan (everything true is a start).
 *
 * @param {Object<string, boolean>|null} prev
 * @param {Object<string, boolean>} next
 * @returns {{start: string[], stop: string[]}}
 */
export function diffPlan(prev, next) {
    const start = [];
    const stop = [];
    ALL_LOOPS.forEach(loop => {
        const was = prev ? !!prev[loop] : false;
        const now = !!next[loop];
        if (now && !was) start.push(loop);
        else if (!now && was) stop.push(loop);
    });
    return { start, stop };
}

/**
 * Whether the screen wake lock should be held right now.
 *
 * The wake lock does not save power on its own — it spends it. Its value is
 * that it lets a coach dim the screen to near-minimum for a three-game day
 * without the session dying, and screen brightness dominates every other term
 * in the battery budget.
 *
 * `userReleased` is the explicit "I'm pocketing this" tap on the header
 * indicator. It is intentionally sticky for the rest of the game: a coach who
 * turned it off should not find it silently back on after switching apps.
 *
 * @param {object} ctx
 * @param {boolean} ctx.supported    - navigator.wakeLock exists
 * @param {boolean} ctx.enabled      - the power.keepScreenAwake setting
 * @param {boolean} ctx.inGame       - the game screen is mounted
 * @param {boolean} ctx.visible      - document.visibilityState === 'visible'
 * @param {boolean} ctx.userReleased - the coach tapped the indicator off
 * @returns {boolean}
 */
export function shouldHoldWakeLock(ctx) {
    if (!ctx) return false;
    // A hidden page cannot hold a wake lock at all — the browser releases it
    // automatically. Reporting false here keeps our bookkeeping honest so the
    // resume path knows it has to re-acquire rather than assuming it still has
    // the sentinel it was handed before the page was hidden.
    return !!(ctx.supported && ctx.enabled && ctx.inGame && ctx.visible && !ctx.userReleased);
}
