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
    /** game/pointManagement.js — elapsed point time readout (display only) */
    POINT_TIMER: 'pointTimer',
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
        [LOOPS.POINT_TIMER]: visible && inGame,

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
