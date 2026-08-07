/*
 * Screen wake lock — keep the display awake during a game.
 *
 * This is the single highest-leverage battery change in the app, and it works
 * by spending power rather than saving it. Screen-on time dominates every other
 * drain during a three-game day; the reason coaches can't dim their phones to
 * near-minimum is that the screen then sleeps and they lose the session. A wake
 * lock removes that coupling: hold the screen on, and the coach is free to turn
 * brightness way down, which is the actual saving.
 *
 * The API's sharp edge: **the browser releases a wake lock automatically
 * whenever the page becomes hidden, and it is not restored on return.** A naive
 * acquire-on-entry implementation therefore works exactly once and silently
 * stops the first time the coach switches apps. That is why this module drives
 * off utils/powerManager.js's visibility broadcast and re-evaluates on every
 * plan — acquiring again on resume rather than assuming it still holds the
 * sentinel it was handed earlier.
 *
 * Support: Chrome/Edge (desktop + Android) and Safari 16.4+. Absent elsewhere,
 * where every entry point below degrades to a silent no-op.
 */
import { shouldHoldWakeLock } from './powerPolicy.js';
import { log } from './logger.js';

const wakeLockManager = (function() {
    const SETTING_KEY = 'power.keepScreenAwake';
    const CHANGED_EVENT = 'breakside:wake-lock-changed';

    /** @type {WakeLockSentinel|null} */
    let sentinel = null;
    // Guards against an acquire() that resolves after we've already decided we
    // no longer want the lock (the coach exited the game while the promise was
    // in flight). Bumped on every state-changing entry point.
    let generation = 0;
    // Sticky "I'm pocketing this phone" opt-out. Cleared on game entry so it
    // never leaks from one game into the next, but deliberately preserved
    // across hide/show within a game.
    let userReleased = false;
    let lastContext = { visible: true, inGame: false };

    function isSupported() {
        return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
    }

    function isEnabled() {
        const v = window.advancedSettings?.get?.(SETTING_KEY);
        // Default on: an unset value (settings module not yet loaded) should
        // not silently disable the feature.
        return v === undefined ? true : !!v;
    }

    function isHeld() {
        return !!sentinel;
    }

    /** Whether the coach has explicitly turned the lock off for this game. */
    function isUserReleased() {
        return userReleased;
    }

    function notifyChanged() {
        document.dispatchEvent(new CustomEvent(CHANGED_EVENT, {
            detail: { held: isHeld(), supported: isSupported(), userReleased }
        }));
    }

    async function acquire() {
        if (sentinel) return;
        const mine = ++generation;
        try {
            const next = await navigator.wakeLock.request('screen');
            // The world may have moved on while we awaited: a game exit or an
            // explicit release bumps `generation`. Drop the lock we just got
            // rather than leaking a sentinel nobody will ever release.
            if (mine !== generation) {
                try { await next.release(); } catch (_) {}
                return;
            }
            sentinel = next;
            // Fires both when we release and when the browser does it for us
            // (page hidden). Clearing our reference here is what keeps
            // `isHeld()` honest for the resume path and the indicator.
            sentinel.addEventListener('release', () => {
                sentinel = null;
                notifyChanged();
            });
            log('🔆 Wake lock acquired');
            notifyChanged();
        } catch (err) {
            // NotAllowedError is expected when the page isn't visible or the
            // OS is in low-power mode. Not worth a toast — the indicator
            // reflects reality either way.
            log(`🔆 Wake lock request failed: ${err && err.name ? err.name : err}`);
            notifyChanged();
        }
    }

    async function release() {
        generation++;
        const current = sentinel;
        sentinel = null;
        if (!current) return;
        try {
            await current.release();
            log('🔆 Wake lock released');
        } catch (_) {
            // Already released by the browser — nothing to do.
        }
        notifyChanged();
    }

    /**
     * Bring the actual lock in line with what the policy says it should be.
     * Safe to call on every power plan; both branches early-return when
     * already in the desired state.
     */
    function reconcile() {
        const want = shouldHoldWakeLock({
            supported: isSupported(),
            enabled: isEnabled(),
            inGame: lastContext.inGame,
            visible: lastContext.visible,
            userReleased
        });
        if (want && !sentinel) {
            acquire();
            // The hint is the other half of the feature: a wake lock nobody
            // knows about doesn't get anyone to dim their screen.
            window.hints?.maybeShow?.(
                'wake-lock-dim',
                'Screen stays awake during the game — turn your brightness down to save battery.'
            );
        } else if (!want && sentinel) {
            release();
        }
    }

    /**
     * Toggle the lock by explicit coach action (the header indicator).
     * Turning it off is sticky for the rest of the game — someone who pockets
     * their phone should not find the screen pinned on again after they
     * switch apps and come back.
     */
    function toggleByUser() {
        userReleased = !userReleased;
        log(`🔆 Wake lock ${userReleased ? 'disabled' : 'enabled'} by coach`);
        reconcile();
        notifyChanged();
        return !userReleased;
    }

    document.addEventListener('breakside:power-plan', (e) => {
        const next = e.detail?.ctx;
        if (!next) return;
        const enteringGame = next.inGame && !lastContext.inGame;
        lastContext = next;
        // A fresh game starts from a clean slate; within a game the opt-out
        // survives hide/show.
        if (enteringGame) userReleased = false;
        reconcile();
    });

    return {
        isSupported,
        isEnabled,
        isHeld,
        isUserReleased,
        toggleByUser,
        reconcile,
        CHANGED_EVENT
    };
})();

// --- ES-module export ---
export { wakeLockManager };
// window survivor: late-bound state accessor (read window-qualified by
// game/gameScreenPanels.js's header indicator and settings/advancedSettings.js,
// which re-reconciles when the coach flips the setting)
window.wakeLockManager = wakeLockManager;
