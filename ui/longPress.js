/*
 * Long-press, delegated — wireLongPress(container, opts) fires opts.onLongPress
 * for a press-and-hold on any descendant matching opts.selector, and swallows
 * the trailing click so a tap handler on the same rows (the Log tab's
 * tap-to-seek, playByPlay/replayView.js) never sees the gesture.
 *
 * Delegated rather than per-element because the rows it serves are rebuilt
 * by innerHTML on every log update. The gesture itself follows
 * ui/setPicker.js: 450 ms, cancelled by a move (a scroll is not a press),
 * the OS text-selection callout suppressed, the context menu blocked.
 */
const LONG_PRESS_MS = 450;

/**
 * @param {HTMLElement} container
 * @param {object} opts
 *   @param {string} opts.selector            - rows that can be pressed
 *   @param {function(HTMLElement): void} opts.onLongPress
 *   @param {number} [opts.ms]                - hold time (default 450)
 *   @param {string} [opts.pressingClass]     - set on the row while held
 */
function wireLongPress(container, { selector, onLongPress, ms = LONG_PRESS_MS, pressingClass = 'pressing' }) {
    if (!container || container._longPressCleanup) return;

    container.style.webkitTouchCallout = 'none';

    let timer = null;
    let row = null;
    let triggered = false;      // the hold fired; swallow the trailing click
    let lastTouchEnd = 0;       // emulated mouse events follow a touch — don't let them reset `triggered`

    const clear = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (row) { row.classList.remove(pressingClass); row = null; }
    };
    const start = (e) => {
        const target = e.target && e.target.closest ? e.target.closest(selector) : null;
        if (!target || !container.contains(target)) return;
        if (e.type === 'mousedown' && (Date.now() - lastTouchEnd) < 1000) return;   // the touch already ran this
        clear();
        triggered = false;
        row = target;
        target.classList.add(pressingClass);
        timer = setTimeout(() => {
            timer = null;
            triggered = true;
            const el = row;
            clear();
            const sel = window.getSelection && window.getSelection();
            if (sel && sel.removeAllRanges) sel.removeAllRanges();
            onLongPress(el);
        }, ms);
    };
    const cancel = (e) => {
        if (e && (e.type === 'touchend' || e.type === 'touchcancel')) lastTouchEnd = Date.now();
        clear();
    };
    // Capture phase, so this runs before the bubbling tap handlers on the
    // same element; stopImmediatePropagation keeps them from running at all.
    const click = (e) => {
        if (!triggered) return;
        triggered = false;
        e.stopImmediatePropagation();
        e.preventDefault();
    };
    const blockContextMenu = (e) => {
        if (e.target && e.target.closest && e.target.closest(selector)) e.preventDefault();
    };

    container.addEventListener('touchstart', start, { passive: true });
    container.addEventListener('touchend', cancel, { passive: true });
    container.addEventListener('touchcancel', cancel, { passive: true });
    container.addEventListener('touchmove', cancel, { passive: true });
    container.addEventListener('mousedown', start);
    container.addEventListener('mouseup', cancel);
    container.addEventListener('mouseleave', cancel);
    container.addEventListener('click', click, true);
    container.addEventListener('contextmenu', blockContextMenu);

    container._longPressCleanup = () => {
        clear();
        container.removeEventListener('touchstart', start);
        container.removeEventListener('touchend', cancel);
        container.removeEventListener('touchcancel', cancel);
        container.removeEventListener('touchmove', cancel);
        container.removeEventListener('mousedown', start);
        container.removeEventListener('mouseup', cancel);
        container.removeEventListener('mouseleave', cancel);
        container.removeEventListener('click', click, true);
        container.removeEventListener('contextmenu', blockContextMenu);
        container._longPressCleanup = null;
    };
}

export { wireLongPress, LONG_PRESS_MS };
