/*
 * Set picker interaction — tap to cycle, long-press for the full list.
 *
 * Shared by every set control so the Full tab's header chip, its modifier-row
 * chip and the Field tab's action-row button all behave identically. The pure
 * side/cycle logic lives in utils/possessionSets.js; this module owns only the
 * DOM wiring and the long-press menu.
 *
 * Controls are rebuilt on every render, so wiring is idempotent per element
 * (a `_setPickerCleanup` handle detaches a previous render's listeners) and
 * every callback re-reads the possession at interaction time rather than
 * closing over one — cloud sync replaces point/possession objects underneath.
 */
import { nextSetValue } from '../utils/possessionSets.js';
import { escapeHtml } from '../utils/gameLogRenderer.js';

const LONG_PRESS_MS = 450;

/**
 * Wire tap-to-cycle + long-press-for-menu onto a set control.
 *
 * @param {HTMLElement} el
 * @param {object} opts
 *   @param {function(): object|null} opts.getPossession - live possession
 *   @param {function(): Array<string>} opts.getLabels   - labels for its side
 *   @param {function(): boolean} [opts.canEdit]         - role gate
 *   @param {function(): void} opts.onChange             - persist + re-render
 */
function wireSetControl(el, opts) {
    if (!el) return;
    if (el._setPickerCleanup) el._setPickerCleanup();

    const allowed = () => (typeof opts.canEdit !== 'function' || opts.canEdit());
    const write = (value) => {
        const possession = opts.getPossession();
        if (!possession) return;
        possession.set = value;
        opts.onChange();
    };

    // A long-press on text otherwise triggers the OS selection UI — the word
    // highlights and Copy/Translate/Look Up pops up over the control. Belt and
    // braces: CSS kills the callout + selection (see .full-pbp-set-chip /
    // .fp-setbtn), and this kills the context menu the gesture would raise.
    el.style.webkitUserSelect = 'none';
    el.style.userSelect = 'none';
    el.style.webkitTouchCallout = 'none';

    let timer = null;
    let triggered = false;   // long-press fired; swallow the trailing click

    const start = () => {
        triggered = false;
        timer = setTimeout(() => {
            timer = null;
            triggered = true;
            if (!allowed()) return;
            const possession = opts.getPossession();
            if (!possession) return;
            // Drop any selection the press managed to start before the CSS
            // guards took effect, so the popover isn't sharing the screen with
            // a highlighted word.
            const sel = window.getSelection && window.getSelection();
            if (sel && sel.removeAllRanges) sel.removeAllRanges();
            showSetMenu(possession.set ?? null, opts.getLabels(), write, el);
        }, LONG_PRESS_MS);
    };
    const blockContextMenu = (e) => { e.preventDefault(); };
    const cancel = () => {
        if (timer) { clearTimeout(timer); timer = null; }
    };
    const click = (e) => {
        // A long-press already handled this gesture.
        if (triggered) {
            triggered = false;
            e.stopPropagation();
            e.preventDefault();
            return;
        }
        if (!allowed()) return;
        const possession = opts.getPossession();
        if (!possession) return;
        write(nextSetValue(possession.set ?? null, opts.getLabels()));
    };

    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchend', cancel);
    el.addEventListener('touchcancel', cancel);
    el.addEventListener('touchmove', cancel);
    el.addEventListener('mousedown', start);
    el.addEventListener('mouseup', cancel);
    el.addEventListener('mouseleave', cancel);
    el.addEventListener('click', click);
    el.addEventListener('contextmenu', blockContextMenu);

    el._setPickerCleanup = () => {
        cancel();
        el.removeEventListener('touchstart', start);
        el.removeEventListener('touchend', cancel);
        el.removeEventListener('touchcancel', cancel);
        el.removeEventListener('touchmove', cancel);
        el.removeEventListener('mousedown', start);
        el.removeEventListener('mouseup', cancel);
        el.removeEventListener('mouseleave', cancel);
        el.removeEventListener('click', click);
        el.removeEventListener('contextmenu', blockContextMenu);
        el._setPickerCleanup = null;
    };
}

/**
 * The long-press menu — a light popover anchored to the control, modelled on
 * the Field tab's player picker (.fp-picker) rather than a full dialog: this
 * is a quick "show me the options" affordance, not a decision worth a modal.
 *
 * Lists every label for this side plus "unspecified", with the current one
 * marked. A tag whose label the team has since deleted is listed too (marked
 * "was removed") so it's visible rather than silently absent from its own
 * menu — tap-cycling alone can never restore it.
 */
function showSetMenu(current, labels, onPick, anchorEl) {
    document.querySelectorAll('.set-picker-pop').forEach(n => n.remove());

    const options = [{ value: null, text: '—' }]
        .concat((labels || []).map(l => ({ value: l, text: l })));
    if (current && !(labels || []).includes(current)) {
        options.push({ value: current, text: `${current} (was removed)` });
    }

    const pop = document.createElement('div');
    pop.className = 'set-picker-pop';
    pop.innerHTML = `<div class="set-picker-pop-ttl">Set for this possession</div>`
        + options.map((o, i) => `<div class="set-picker-pop-opt${o.value === current ? ' selected' : ''}"`
            + ` data-idx="${i}">${escapeHtml(o.text)}</div>`).join('');

    // Measure before positioning so the popover always lands fully on-screen
    // (same approach as .fp-picker): prefer above the control, flip below when
    // there isn't room, then clamp to the viewport.
    pop.style.left = '0px';
    pop.style.top = '0px';
    pop.style.visibility = 'hidden';
    document.body.appendChild(pop);

    const margin = 8;
    const r = anchorEl ? anchorEl.getBoundingClientRect() : null;
    const cx = r ? r.left + r.width / 2 : window.innerWidth / 2;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = Math.max(margin, Math.min(cx - pw / 2, window.innerWidth - pw - margin));
    let top = r ? r.top - ph - 8 : (window.innerHeight - ph) / 2;
    if (top < margin) top = r ? r.bottom + 8 : margin;
    top = Math.max(margin, Math.min(top, window.innerHeight - ph - margin));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.visibility = 'visible';

    pop.querySelectorAll('.set-picker-pop-opt').forEach(opt => {
        opt.onclick = (ev) => {
            ev.stopPropagation();
            pop.remove();
            onPick(options[Number(opt.dataset.idx)].value);
        };
    });
    // Deferred so the pointerdown that opened this popover doesn't close it.
    setTimeout(() => {
        const close = (ev) => {
            if (!pop.contains(ev.target)) {
                pop.remove();
                document.removeEventListener('pointerdown', close);
            }
        };
        document.addEventListener('pointerdown', close);
    }, 0);
}

export { wireSetControl, showSetMenu };
