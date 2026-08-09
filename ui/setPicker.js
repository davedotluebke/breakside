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
            showSetMenu(possession.set ?? null, opts.getLabels(), write);
        }, LONG_PRESS_MS);
    };
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
        el._setPickerCleanup = null;
    };
}

/**
 * The long-press menu: every label for this side plus "unspecified", with the
 * current one marked. A tag whose label the team has since deleted is listed
 * too (marked "no longer configured") so it's visible rather than silently
 * absent from its own menu.
 */
function showSetMenu(current, labels, onPick) {
    const existing = document.getElementById('setPickerMenu');
    if (existing) existing.remove();

    const options = [{ value: null, text: '— (unspecified)' }]
        .concat((labels || []).map(l => ({ value: l, text: l })));
    if (current && !(labels || []).includes(current)) {
        options.push({ value: current, text: `${current} (no longer configured)` });
    }

    const modal = document.createElement('div');
    modal.id = 'setPickerMenu';
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
        <div class="modal-content set-picker-menu-content">
            <div class="dialog-header prominent-dialog-header">
                <h2>Set for this possession</h2>
                <span class="close">&times;</span>
            </div>
            <div class="set-picker-options">
                ${options.map((o, i) => `
                    <button type="button" class="set-picker-option${o.value === current ? ' selected' : ''}"
                            data-idx="${i}">${escapeHtml(o.text)}</button>
                `).join('')}
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.close').onclick = close;
    modal.onclick = (e) => { if (e.target === modal) close(); };
    modal.querySelectorAll('.set-picker-option').forEach(btn => {
        btn.onclick = () => {
            close();
            onPick(options[Number(btn.dataset.idx)].value);
        };
    });
}

export { wireSetControl, showSetMenu };
