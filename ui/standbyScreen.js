/*
 * Standby screen — a true-black overlay for the phone on the sideline.
 *
 * Dark mode already paints the page #000, but a game screen is mostly
 * *content*: buttons, tables, the log. Standby throws all of that away and
 * shows the two things a coach standing on the line actually needs — the
 * score, and between points the countdown to the next pull — as dim text on
 * black. On an OLED panel a black pixel is an unlit pixel, so the saving
 * scales with how little the screen shows; on an LCD it is merely a calmer
 * display (the backlight is uniform whatever is drawn), which is why the
 * settings copy says "OLED" rather than promising a universal win.
 *
 * It composes with the wake lock rather than replacing it: the lock keeps the
 * screen alive, standby makes keeping it alive cheap. Entered by tapping the
 * ☀ in the game header (game/gameScreenPanels.js), left by tapping anywhere.
 *
 * Three rules, each the answer to a failure mode:
 *
 *  - **The waking tap is swallowed.** Whatever the coach taps to wake the
 *    screen must not also land on the control underneath — a They Score under
 *    the thumb records a phantom goal. The overlay is the tap's own target, so
 *    the game UI never sees it, and it keeps intercepting through its short
 *    fade-out so a bounced double-tap is absorbed too. Hiding the overlay on
 *    pointerup instead would let the browser's synthesized click land on
 *    whatever is under the finger by then.
 *  - **It mirrors; it does not compute.** Score and countdown are read off the
 *    header elements the game already keeps current, via a MutationObserver,
 *    so standby owns no timer and no second copy of the game state — zero
 *    extra wakeups while it is up (see utils/powerPolicy.js on why that is the
 *    number that matters). The pure read rules are in utils/standbyView.js.
 *  - **It never outlives the game screen.** Leaving or ending the game (the
 *    power plan's `inGame` going false) tears it down, so a black overlay
 *    cannot be left sitting over the game summary.
 *
 * Toasts stay above it on purpose (z-index, ui/standbyScreen.css): a handoff
 * request from another coach is exactly the thing a coach in standby needs to
 * see. Being backgrounded does not leave standby — a coach who pocketed the
 * phone in standby comes back to standby.
 *
 * ui/standbyTimer.js enters standby by itself after an idle spell, through
 * `enter({ soft: true })`: the overlay fades in without taking the tap
 * (`pointer-events: none` for the fade), so a touch during it reaches the
 * game UI and the timer cancels the entry. Only once fully in does it become
 * the tap-swallowing screen above. The gate on when that may happen is
 * utils/standbyPolicy.js.
 */
import { powerManager } from '../utils/powerManager.js';
import { standbyLabels, countdownState } from '../utils/standbyView.js';
import { currentTeam } from '../store/storage.js';
import { currentGame } from '../utils/helpers.js';
import { applyTheme } from '../utils/theme.js';
import { log } from '../utils/logger.js';

const standbyScreen = (function() {
    const CHANGED_EVENT = 'breakside:standby-changed';
    // Belt and braces for the fade: transitionend is the normal path, but a
    // display:none'd ancestor or a throttled tab can eat it.
    const FADE_FALLBACK_MS = 400;
    const STANDBY_THEME_COLOR = '#000000';

    /** @type {HTMLElement|null} built on first use, kept for the session */
    let overlay = null;
    let active = false;
    let leaving = false;
    // Soft entry in progress: visible, fading in, not yet the tap target.
    let entering = false;
    let enterTimer = null;
    const ENTER_FALLBACK_MS = 1000;
    /** @type {MutationObserver|null} */
    let observer = null;
    let fadeTimer = null;
    let savedThemeColor = null;

    function isActive() {
        return active && !leaving;
    }

    /** Fading in by itself (ui/standbyTimer.js); a tap still reaches the game. */
    function isEntering() {
        return entering;
    }

    function inGame() {
        return !!powerManager.getContext().inGame;
    }

    function textOf(id) {
        const el = document.getElementById(id);
        return el ? (el.textContent || '') : '';
    }

    function setText(id, value) {
        const el = document.getElementById(id);
        if (el && el.textContent !== value) el.textContent = value;
    }

    // ─── Build ──────────────────────────────────────────────────────────────

    function build() {
        overlay = document.createElement('div');
        overlay.id = 'standbyScreen';
        overlay.className = 'standby-screen';
        overlay.setAttribute('role', 'button');
        overlay.setAttribute('aria-label', 'Standby. Tap to return to the game.');
        overlay.innerHTML = `
            <div class="standby-score" id="standbyScore">
                <span class="standby-score-value" id="standbyScoreUs">0</span>
                <span class="standby-score-sep" aria-hidden="true">–</span>
                <span class="standby-score-value" id="standbyScoreThem">0</span>
            </div>
            <div class="standby-labels" id="standbyLabels">
                <span class="standby-label" id="standbyLabelUs">Us</span>
                <span class="standby-labels-sep" aria-hidden="true">·</span>
                <span class="standby-label" id="standbyLabelThem">Them</span>
            </div>
            <div class="standby-countdown" id="standbyCountdown" hidden>
                <span class="standby-countdown-label">Next point</span>
                <span class="standby-countdown-value" id="standbyCountdownValue">00:00</span>
            </div>
            <div class="standby-hint">Tap to return</div>
        `;

        // The overlay is the tap's target, so nothing underneath can hear it;
        // stopping propagation additionally keeps document-level listeners
        // (menu closers, drag handlers) from reacting to a wake tap. Not
        // preventDefault on the touch events — that would cancel the click
        // we exit on.
        const swallow = (e) => { e.stopPropagation(); };
        ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'touchcancel',
         'mousedown', 'mouseup', 'dblclick'].forEach(type => {
            overlay.addEventListener(type, swallow, { passive: true });
        });
        overlay.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            exit('tap');
        });
        // A long press on the black screen must not raise the OS callout.
        overlay.addEventListener('contextmenu', (e) => { e.preventDefault(); });
        overlay.addEventListener('transitionend', (e) => {
            if (e.target !== overlay) return;
            if (entering) finishEnter();
            else finishLeave();
        });

        document.body.appendChild(overlay);
    }

    // ─── Mirroring ──────────────────────────────────────────────────────────

    /** Read the score and countdown off the game's own elements. */
    function syncFromDom() {
        if (!overlay) return;
        setText('standbyScoreUs', textOf('gameScoreUs') || '0');
        setText('standbyScoreThem', textOf('gameScoreThem') || '0');

        const box = document.getElementById('countdownTimer');
        const display = document.getElementById('timerDisplay');
        const cd = countdownState({
            display: box ? box.style.display : '',
            text: display ? display.textContent : '',
            danger: !!(display && display.classList.contains('timer-danger'))
        });
        const el = document.getElementById('standbyCountdown');
        if (!el) return;
        el.hidden = !cd.running;
        if (cd.running) {
            setText('standbyCountdownValue', cd.text);
            el.classList.toggle('standby-countdown--urgent', cd.urgent);
        }
    }

    function refreshLabels() {
        const game = currentGame();
        const labels = standbyLabels({
            team: currentTeam,
            opponent: game ? game.opponent : null
        });
        setText('standbyLabelUs', labels.us);
        setText('standbyLabelThem', labels.them);
    }

    function observe() {
        if (observer) return;
        observer = new MutationObserver(syncFromDom);
        const textOpts = { childList: true, characterData: true, subtree: true };
        ['gameScoreUs', 'gameScoreThem', 'timerDisplay'].forEach(id => {
            const el = document.getElementById(id);
            if (el) observer.observe(el, textOpts);
        });
        // The countdown box's inline display is how the game says "between
        // points"; its text node above is what ticks.
        const box = document.getElementById('countdownTimer');
        if (box) observer.observe(box, { attributes: true, attributeFilter: ['style'] });
    }

    function unobserve() {
        if (!observer) return;
        observer.disconnect();
        observer = null;
    }

    // ─── Browser chrome ─────────────────────────────────────────────────────

    // In the light theme the status bar / browser chrome is white, which on
    // a black standby screen is a lit strip along the top. Push it to black
    // for the duration and hand it back to the theme afterwards. (iOS reads
    // its standalone status-bar style once at launch, so this helps Android
    // and in-browser use; harmless elsewhere.)
    //
    // Handing back means re-running the theme rather than restoring the value
    // we saw on the way in: utils/theme.js may have re-resolved in between (an
    // `auto` preference following the OS flipping at dusk, mid-game), and the
    // saved value would then be the wrong theme's. The saved copy is only the
    // fallback for a theme module that isn't there.
    function setChromeBlack(on) {
        const meta = document.querySelector('meta[name="theme-color"]');
        if (!meta) return;
        if (on) {
            if (savedThemeColor === null) savedThemeColor = meta.getAttribute('content');
            meta.setAttribute('content', STANDBY_THEME_COLOR);
        } else {
            const saved = savedThemeColor;
            savedThemeColor = null;
            if (typeof applyTheme === 'function') applyTheme();
            else if (saved !== null) meta.setAttribute('content', saved);
        }
    }

    // A theme change while standby is up rewrites theme-color underneath us;
    // put it back to black until we leave.
    document.addEventListener('breakside:theme-changed', () => {
        if (isActive()) setChromeBlack(true);
    });

    // ─── Enter / exit ───────────────────────────────────────────────────────

    function notify() {
        document.dispatchEvent(new CustomEvent(CHANGED_EVENT, {
            detail: { active: isActive(), entering }
        }));
    }

    function onKey(e) {
        if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            exit('key');
        }
    }

    /**
     * Cover the game with the standby screen.
     *
     * `soft` is the idle timer's entry: a slower fade-in during which the
     * overlay is not the tap target, so a touch reaches the UI underneath
     * (and, via the timer's input listener, cancels the entry). A deliberate
     * ☀ tap during a soft fade completes it at once.
     *
     * @param {object} [opts]
     * @param {boolean} [opts.soft=false]
     * @returns {boolean} whether standby is now on or on its way (false outside a game)
     */
    function enter(opts) {
        const soft = !!(opts && opts.soft);
        if (entering) {
            if (!soft) finishEnter();
            return true;
        }
        if (isActive()) return true;
        if (!inGame()) return false;
        if (!overlay) build();

        // Re-entered during a fade-out: cancel the leave and keep the overlay.
        if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
        leaving = false;
        active = true;

        refreshLabels();
        syncFromDom();
        observe();
        overlay.classList.remove('standby-screen--leaving');
        if (soft) {
            entering = true;
            // Commit the transparent start state, then let the class change
            // drive the transition to opaque.
            overlay.classList.add('standby-screen--entering', 'standby-screen--entering-start', 'standby-screen--active');
            void overlay.getBoundingClientRect();
            overlay.classList.remove('standby-screen--entering-start');
            enterTimer = setTimeout(finishEnter, ENTER_FALLBACK_MS);
        } else {
            overlay.classList.add('standby-screen--active');
        }
        document.body.classList.add('standby-active');
        setChromeBlack(true);
        document.addEventListener('keydown', onKey);
        log(soft ? '🌙 Standby fading in (idle)' : '🌙 Standby on');
        notify();
        return true;
    }

    /** The soft fade-in reached opaque: become the ordinary standby screen. */
    function finishEnter() {
        if (!entering) return;
        entering = false;
        if (enterTimer) { clearTimeout(enterTimer); enterTimer = null; }
        overlay.classList.remove('standby-screen--entering', 'standby-screen--entering-start');
        log('🌙 Standby on (idle)');
        notify();
    }

    /**
     * Abandon a soft fade-in: the coach touched something. Immediate, with
     * no fade-out, because the tap that cancelled it has already reached the
     * UI and a swallowing fade here would eat the next one.
     * @param {string} reason
     * @returns {boolean} whether there was a fade-in to cancel
     */
    function cancelEntering(reason) {
        if (!entering) return false;
        entering = false;
        if (enterTimer) { clearTimeout(enterTimer); enterTimer = null; }
        active = false;
        leaving = false;
        unobserve();
        setChromeBlack(false);
        document.removeEventListener('keydown', onKey);
        overlay.classList.remove('standby-screen--active', 'standby-screen--entering', 'standby-screen--entering-start');
        document.body.classList.remove('standby-active');
        log(`🌙 Standby fade-in cancelled (${reason || 'input'})`);
        notify();
        return true;
    }

    /**
     * Start leaving standby. The overlay keeps intercepting taps until its
     * fade completes (finishLeave), which is what absorbs a bounced tap.
     * @param {string} reason - for the log line
     * @returns {boolean} whether a leave was started
     */
    function exit(reason) {
        if (entering) return cancelEntering(reason);
        if (!isActive()) return false;
        leaving = true;
        unobserve();
        setChromeBlack(false);
        document.removeEventListener('keydown', onKey);
        overlay.classList.add('standby-screen--leaving');
        fadeTimer = setTimeout(finishLeave, FADE_FALLBACK_MS);
        log(`🌙 Standby off (${reason || 'tap'})`);
        notify();
        return true;
    }

    function finishLeave() {
        if (!leaving) return;
        if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
        leaving = false;
        active = false;
        overlay.classList.remove('standby-screen--active', 'standby-screen--leaving');
        document.body.classList.remove('standby-active');
    }

    function toggle() {
        return isActive() ? !exit('toggle') : enter();
    }

    // Leaving or ending the game tears standby down. The plan event carries
    // the whole context, so a missed edge still converges on the next one.
    document.addEventListener('breakside:power-plan', (e) => {
        const ctx = e.detail && e.detail.ctx;
        if (ctx && !ctx.inGame && (active || leaving || entering)) {
            exit('game-exit');
            // No fade to wait for here: the screen underneath is changing.
            finishLeave();
        }
    });

    return { enter, exit, toggle, isActive, isEntering, cancelEntering, CHANGED_EVENT };
})();

// --- ES-module export ---
export { standbyScreen };
