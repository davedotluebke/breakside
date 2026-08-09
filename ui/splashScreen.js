/*
 * Boot splash screen
 *
 * index.html ships with #teamRosterScreen visible (it has no inline
 * display:none), so between first paint and the end of initializeApp() the user
 * briefly sees the Start Game subscreen before the app navigates to the team
 * list. Rather than hide the screens up front — the app measures button widths
 * at DOMContentLoaded and hidden elements measure zero — we cover the boot with
 * a full-screen wordmark panel and retract it once a real screen is up.
 *
 * Dismissal is signal-driven, not timer-driven:
 *   - screens/navigation.js dispatches breakside:screen-shown for every
 *     showScreen() call; the first one means an app screen is on and usable.
 *   - main.js calls dismissSplash() directly on the auth-screen path, which
 *     bypasses showScreen().
 *   - MAX_VISIBLE_MS is a safety net only: the splash must never be able to
 *     lock the user out of the app if a signal is missed.
 *
 * The one path that deliberately keeps the splash up is the logged-out redirect
 * to /landing/ — no screen is shown there, and covering the hop is the point.
 *
 * Styles live in css/splash.css.
 */

const MIN_VISIBLE_MS = 500;   // don't flash-and-vanish on a warm/cached load
const LOGO_GRACE_MS = 1500;   // extra wait for a slow logo fetch, once app-ready
const MAX_VISIBLE_MS = 6000;  // hard cap — never hold the app hostage
const SLIDE_MS = 520;         // keep in sync with the transition in css/splash.css

const splash = document.getElementById('splashScreen');
const shownAt = Date.now();

let dismissed = false;
let appReady = false;
let logoReady = false;

// Track the logo's arrival so the shade doesn't fly up as an empty white panel
// on a cold first load. An errored image counts as "ready" — there is nothing
// left to wait for.
if (splash) {
    const logo = splash.querySelector('.splash-logo');
    if (!logo || logo.complete) {
        logoReady = true;
    } else {
        const onSettled = () => { logoReady = true; maybeRetract(); };
        logo.addEventListener('load', onSettled, { once: true });
        logo.addEventListener('error', onSettled, { once: true });
    }
}

/** Remove the splash from the DOM. Idempotent. */
function removeSplash() {
    if (splash && splash.isConnected) splash.remove();
}

/** Start the retract animation and drop the node once it finishes. */
function retract() {
    if (!splash || !splash.isConnected) return;
    splash.classList.add('splash-retracting');
    splash.addEventListener('transitionend', removeSplash, { once: true });
    // transitionend never fires if the element is display:none'd by other CSS,
    // if the transition is overridden, or in a background tab that throttles
    // rendering. Always have a floor under it.
    setTimeout(removeSplash, SLIDE_MS + 250);
}

/**
 * Retract once the app is ready AND (the logo has arrived OR its grace period
 * has expired), never sooner than MIN_VISIBLE_MS after first paint.
 */
function maybeRetract() {
    if (dismissed || !appReady) return;
    const elapsed = Date.now() - shownAt;
    if (!logoReady && elapsed < LOGO_GRACE_MS) {
        // Re-checked by the logo's load/error handler, and by the hard cap.
        return;
    }
    dismissed = true;
    setTimeout(retract, Math.max(0, MIN_VISIBLE_MS - elapsed));
}

/**
 * Signal that the app has reached a usable screen. Safe to call more than once
 * and before the app finishes booting.
 */
function dismissSplash() {
    if (appReady) return;
    appReady = true;
    maybeRetract();
    // Cover the case where app-ready arrives before the logo and the logo never
    // settles: re-evaluate when the grace period is up.
    setTimeout(maybeRetract, LOGO_GRACE_MS);
}

if (splash) {
    document.addEventListener('breakside:screen-shown', dismissSplash);

    // Safety net: retract regardless of signals so a boot failure leaves the
    // user looking at the app (however broken) rather than a logo forever.
    setTimeout(() => {
        dismissed = true;
        retract();
    }, MAX_VISIBLE_MS);
}

export { dismissSplash };
