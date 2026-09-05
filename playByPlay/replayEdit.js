/*
 * Replay editor — editing v1 for the replay viewer (docs/replay-viewer-plan.md
 * step 8, Decision 11): while the replay is PAUSED, the line under the
 * playhead can have its players, modifier flags and spots (the thrower's
 * release point, the receiver's catch point) changed.
 *
 * Owned and mounted by playByPlay/replayView.js (the Edit button on the
 * transport bar toggles it). The sheet sits between the transport and the
 * timeline; every write goes through pbpPossession.amendEvent — this module
 * never touches an event field itself except for the live preview while a
 * spot is being dragged (restored before the amendment is applied, so the
 * bus payload's previousEvent is honest).
 *
 * Gate: cfg.canEdit() at every write — any coach of the team; a viewer
 * never sees the ✎ (replayView hides it), the toast is only a backstop
 * for a role that changes while the sheet is open.
 *
 * Receiver / thrower change (Decision 11): when the next throw in the
 * possession is thrown by someone other than the new receiver — or the
 * previous play left the disc with someone other than the new thrower —
 * an inline confirm offers "change the neighbour" or "insert two Unknown
 * Player passes"; nothing is written until one is picked.
 *
 * Not in v1 (deliberately): flipping score_flag from a spot that enters or
 * leaves the endzone — a goal change moves the score and the point boundary,
 * which is the score-attribution flow's job; inserting/deleting events;
 * editing the opponent's plays.
 */
import { UNKNOWN_PLAYER } from '../store/models.js';
import { playerStub } from '../utils/helpers.js';
import { escapeHtml } from '../utils/gameLogRenderer.js';
import * as fieldRender from './fieldRender.js';
import { modifiersFor, receiverChainConflict, throwerChainConflict, nextInPossession, holderSourceOf, nameOf } from './eventAmend.js';

// pbpPossession (the amendEvent chokepoint) and the controller toast are
// late-bound: importing either here closes an import cycle back through
// game/gameLogic → teams/teamList → teams/gameSummary → replayView. Both
// owners keep their window shims (`// window survivor:` at the owner).
const possession = () => window.pbpPossession || null;
const toast = (msg, kind, ms) => {
    if (typeof window.showControllerToast === 'function') window.showControllerToast(msg, kind, ms);
    else console.warn('[replayEdit]', msg);
};

const EDITABLE_TYPES = new Set(['Throw', 'Turnover', 'Defense', 'Pull']);
const ROLE_LABELS = { thrower: 'Thrower', receiver: 'Receiver', defender: 'Defender', puller: 'Puller' };

/** Which player fields an event exposes for editing, in display order. */
function rolesFor(ev) {
    if (!ev) return [];
    if (ev.type === 'Throw') return ['thrower', 'receiver'];
    if (ev.type === 'Turnover') {
        const roles = [];
        if (ev.thrower) roles.push('thrower');
        if (ev.receiver || ev.drop_flag) roles.push('receiver');
        return roles;
    }
    if (ev.type === 'Defense') return ev.defender ? ['defender'] : [];
    if (ev.type === 'Pull') return ['puller'];
    return [];
}

/**
 * Which located spots an event exposes, as "Move <who>" buttons: the spot
 * belongs to a player (the thrower releases from `from`, the receiver
 * catches at `to`) so the button is named for the player, not the field.
 */
function spotButtons(ev) {
    if (!ev) return [];
    if (ev.type === 'Throw') return [{ field: 'from', who: 'thrower' }, { field: 'to', who: 'receiver' }];
    if (ev.type === 'Turnover') {
        const out = [];
        if (ev.thrower) out.push({ field: 'from', who: 'thrower' });
        out.push({ field: 'to', who: ev.drop_flag ? 'receiver' : 'disc' });
        return out;
    }
    if (ev.type === 'Defense') return [{ field: 'to', who: 'defender' }];
    if (ev.type === 'Pull') return [{ field: 'to', who: 'landing spot' }];
    return [];
}

/**
 * @param {object} ctx
 * @param {HTMLElement} ctx.root - the .rv-root
 * @param {HTMLElement} ctx.fieldEl - the .rv-field (drag surface for "Move spot")
 * @param {object} ctx.view - the renderer view {o, flipAD, flipHA} the field is drawn with
 * @param {object} ctx.engine - replay engine
 * @param {object} ctx.controller - replay controller
 * @param {() => object} ctx.getGame
 * @param {() => object} ctx.getEntryOptions - resolvePlayerName for roster entries
 * @param {(name: string) => object|null} ctx.getPlayerByName - Player objects for chips / patches
 * @param {() => boolean} [ctx.canEdit] - permission gate (absent = allowed)
 * @param {string} [ctx.editDeniedMessage]
 * @param {() => void} [ctx.onEdited] - mount-site hook after a write (re-render log lines, stats)
 * @param {() => void} ctx.redraw - re-render the current playhead position from live events
 * @param {() => void} ctx.refreshView - rebuild engine + timeline after the game changed
 */
function createReplayEditor(ctx) {
    const { root, fieldEl, view, engine, controller } = ctx;
    const panel = document.createElement('div');
    panel.className = 'rv-edit';
    panel.hidden = true;
    root.querySelector('.rv-transport').insertAdjacentElement('afterend', panel);

    let active = false;
    let armed = null;           // 'from' | 'to' | null — which spot the next tap/drag on the pitch places
    let pending = null;         // receiver-chain confirm: { ev, patch, conflict, newName }
    let drag = null;            // live spot drag: { ev, next, origTo, origFrom }
    let renderedIndex = null;

    // ---- helpers ----
    const copyLoc = loc => (loc && typeof loc.x === 'number') ? { x: loc.x, y: loc.y } : null;
    const currentEntry = () => engine.entries[controller.index] || null;
    const editableEvent = entry => (entry && entry.kind === 'event' && entry.event && EDITABLE_TYPES.has(entry.event.type)) ? entry.event : null;
    const pointOf = entry => (entry && entry.pointIdx !== null && entry.pointIdx !== undefined) ? (engine.game.points || [])[entry.pointIdx] : null;

    function gate() {
        if (typeof ctx.canEdit === 'function' && !ctx.canEdit()) {
            toast(ctx.editDeniedMessage || 'You can’t edit plays in this game', 'warning', 2200);
            close();
            return false;
        }
        return true;
    }

    /** Point roster as display names (the same resolution the log's roster line uses). */
    function rosterNames(point) {
        const resolve = (ctx.getEntryOptions && ctx.getEntryOptions().resolvePlayerName) || (n => n);
        const seen = new Set();
        const out = [];
        [].concat(point.players || [], point.substitutedInPlayers || []).forEach(raw => {
            const name = String(resolve(raw));
            if (!name || seen.has(name)) return;
            seen.add(name);
            out.push(name);
        });
        return out;
    }

    function playerFor(name) {
        if (name === UNKNOWN_PLAYER) {
            const pp = possession();
            return (pp && pp.getUnknown && pp.getUnknown()) || { name: UNKNOWN_PLAYER, id: null };
        }
        const p = typeof ctx.getPlayerByName === 'function' ? ctx.getPlayerByName(name) : null;
        return p || playerStub(name);
    }

    function chipsHTML(point, selectedName) {
        const names = rosterNames(point);
        const sel = selectedName || null;
        if (sel && sel !== UNKNOWN_PLAYER && !names.includes(sel)) names.push(sel);   // a player no longer on the roster
        let h = names.map(name => {
            const p = (typeof ctx.getPlayerByName === 'function' && ctx.getPlayerByName(name)) || { name };
            return fieldRender.chipHTML({ name, number: p.number != null ? p.number : null }, { armed: name === sel });
        }).join('');
        h += fieldRender.chipHTML({ name: UNKNOWN_PLAYER }, { unknown: true, armed: sel === UNKNOWN_PLAYER });
        return h;
    }

    // ---- render ----
    function render() {
        if (!active) { panel.hidden = true; return; }
        const entry = currentEntry();
        renderedIndex = controller.index;
        const ev = editableEvent(entry);
        const point = pointOf(entry);
        let h = `<div class="rv-edit-hd">
            <span class="rv-edit-ttl">Editing</span>
            <span class="rv-edit-txt">${entry ? escapeHtml(entry.text || '') : ''}</span>
            <button type="button" class="rv-edit-done">Done</button>
        </div>`;
        if (!ev || !point) {
            h += `<div class="rv-edit-hint">${entry && entry.event
                ? 'This line can’t be edited here.'
                : 'Tap a play in the log to edit it.'}</div>`;
        } else {
            rolesFor(ev).forEach(role => {
                h += `<div class="rv-edit-row" data-role="${role}">
                    <span class="rv-edit-lbl">${ROLE_LABELS[role]}</span>
                    <div class="rv-edit-chips">${chipsHTML(point, nameOf(ev[role]))}</div>
                </div>`;
            });
            const mods = modifiersFor(ev);
            if (mods.length) {
                h += `<div class="rv-edit-row" data-role="modifiers">
                    <span class="rv-edit-lbl">Flags</span>
                    <div class="rv-edit-chips">${mods.map(m =>
                        `<button type="button" class="rv-mod${ev[m.prop] ? ' on' : ''}" data-prop="${m.prop}">${escapeHtml(m.label)}</button>`).join('')}</div>
                </div>`;
            }
            const spots = spotButtons(ev);
            if (spots.length) {
                h += `<div class="rv-edit-row" data-role="spot">
                    <span class="rv-edit-lbl">Spot</span>
                    <div class="rv-edit-chips">${spots.map(sp => {
                        const on = armed === sp.field;
                        const label = on ? 'Tap or drag on the field…' : `${ev[sp.field] ? 'Move' : 'Place'} ${sp.who}`;
                        return `<button type="button" class="rv-edit-spot${on ? ' on' : ''}" data-field="${sp.field}">${escapeHtml(label)}</button>`;
                    }).join('')}</div>
                </div>`;
            }
            if (pending && pending.ev === ev) {
                const c = pending.conflict, nn = escapeHtml(pending.newName);
                const txt = pending.side === 'next'
                    ? `The next throw is by <b>${escapeHtml(c.thrower)}</b>, not ${nn}.`
                    : (c.field === 'defender'
                        ? `The previous play was an interception by <b>${escapeHtml(c.holder)}</b>, not ${nn}.`
                        : `The previous pass was caught by <b>${escapeHtml(c.holder)}</b>, not ${nn}.`);
                const retarget = pending.side === 'next' ? `Change next thrower to ${nn}`
                    : (c.field === 'defender' ? `Change interceptor to ${nn}` : `Change previous receiver to ${nn}`);
                h += `<div class="rv-edit-confirm">
                    <div class="rv-edit-confirm-txt">${txt}</div>
                    <button type="button" data-chain="retarget">${retarget}</button>
                    <button type="button" data-chain="bridge">Insert two Unknown Player passes</button>
                    <button type="button" data-chain="cancel">Cancel</button>
                </div>`;
            }
        }
        panel.innerHTML = h;
        panel.hidden = false;
        root.classList.toggle('rv-spot-armed', armed);
    }

    // ---- writes ----
    function amend(ev, patch, chain) {
        if (!gate()) return;
        const pp = possession();
        if (!pp || typeof pp.amendEvent !== 'function') { toast('Editing isn’t available', 'warning', 2200); return; }
        const res = pp.amendEvent(ev, patch, { game: ctx.getGame(), chain, source: 'manual' });
        if (!res) { toast('That play is no longer in the game', 'warning', 2200); close(); return; }
        afterAmend(ev);
    }

    function afterAmend(ev) {
        if (typeof ctx.onEdited === 'function') { try { ctx.onEdited(); } catch (e) { console.warn('[replayEdit] onEdited failed', e); } }
        ctx.refreshView();
        // A bridge inserts lines above the playhead: follow the edited play.
        const i = engine.entries.findIndex(e => e.event === ev);
        if (i >= 0 && i !== controller.index) controller.seek(i);
        render();
    }

    function changePlayer(ev, role, name) {
        if (nameOf(ev[role]) === name) return;
        const p = playerFor(name);
        const point = pointOf(currentEntry());
        const conflict = role === 'receiver' ? receiverChainConflict(point, ev, p)
            : role === 'thrower' ? throwerChainConflict(point, ev, p) : null;
        if (conflict) {
            pending = { ev, patch: { [role]: p }, conflict, newName: name, side: role === 'receiver' ? 'next' : 'prev' };
            render();
            return;
        }
        amend(ev, { [role]: p });
    }

    // ---- spot drag (armed only) ----
    function fieldLoc(clientX, clientY) {
        const r = fieldEl.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        const fx = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
        const fy = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
        const yd = fieldRender.toField(view, fx, fy);
        return fieldRender.toNorm(fieldRender.clampLoc(yd.l, yd.w));
    }
    // Live preview mutates the armed spot and the neighbour it is chained to
    // (a `to` is the next event's `from`; a `from` is the previous catch) —
    // the same pair applyEventPatch will move for real on release.
    function previewSpot(loc) {
        drag.ev[drag.field] = copyLoc(loc);
        if (drag.partner) drag.partner[drag.partnerField] = copyLoc(loc);
        ctx.redraw();
    }
    function onFieldDown(e) {
        if (!active || !armed || drag) return;
        const entry = currentEntry();
        const ev = editableEvent(entry);
        if (!ev || !(armed in ev)) return;
        const loc = fieldLoc(e.clientX, e.clientY);
        if (!loc) return;
        const point = pointOf(entry);
        const field = armed;
        let partner = null, partnerField = null;
        if (field === 'to') { const n = nextInPossession(point, ev); if (n && 'from' in n) { partner = n; partnerField = 'from'; } }
        else { const p = holderSourceOf(point, ev); if (p && 'to' in p) { partner = p; partnerField = 'to'; } }
        drag = { ev, field, partner, partnerField, orig: copyLoc(ev[field]), partnerOrig: partner ? copyLoc(partner[partnerField]) : null };
        try { fieldEl.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
        e.preventDefault();
        previewSpot(loc);
    }
    function onFieldMove(e) {
        if (!drag) return;
        const loc = fieldLoc(e.clientX, e.clientY);
        if (loc) previewSpot(loc);
    }
    function onFieldUp(e) {
        if (!drag) return;
        const d = drag; drag = null;
        const loc = e.type === 'pointercancel' ? null : fieldLoc(e.clientX, e.clientY);
        // Undo the preview so amendEvent sees (and reports) the real before-state.
        d.ev[d.field] = d.orig;
        if (d.partner) d.partner[d.partnerField] = d.partnerOrig;
        armed = null;
        if (!loc) { ctx.redraw(); render(); return; }
        amend(d.ev, { [d.field]: loc });
    }
    fieldEl.addEventListener('pointerdown', onFieldDown);
    fieldEl.addEventListener('pointermove', onFieldMove);
    fieldEl.addEventListener('pointerup', onFieldUp);
    fieldEl.addEventListener('pointercancel', onFieldUp);

    // ---- sheet wiring ----
    panel.addEventListener('click', e => {
        const t = e.target;
        if (t.closest('.rv-edit-done')) { close(); return; }
        const entry = currentEntry();
        const ev = editableEvent(entry);
        if (!ev) return;
        const chain = t.closest('[data-chain]');
        if (chain) {
            const p = pending; pending = null;
            if (!p || p.ev !== ev || chain.dataset.chain === 'cancel') { render(); return; }
            amend(ev, p.patch, chain.dataset.chain);
            return;
        }
        const chip = t.closest('.fp-chip[data-pname]');
        if (chip) {
            const row = chip.closest('.rv-edit-row');
            if (row && ROLE_LABELS[row.dataset.role]) changePlayer(ev, row.dataset.role, chip.dataset.pname);
            return;
        }
        const mod = t.closest('.rv-mod[data-prop]');
        if (mod) { amend(ev, { [mod.dataset.prop]: !ev[mod.dataset.prop] }); return; }
        const spot = t.closest('.rv-edit-spot[data-field]');
        if (spot) { armed = armed === spot.dataset.field ? null : spot.dataset.field; render(); }
    });

    // The playhead moved (log tap, ⏮/⏭, scrub): show that line's sheet.
    const offField = controller.on('field', ({ index }) => {
        if (!active || index === renderedIndex) return;
        pending = null; armed = null; drag = null;
        render();
    });

    // ---- lifecycle ----
    function open() {
        if (active) return true;
        if (!gate()) return false;
        controller.pause();
        if (!controller.setEditing(true)) return false;
        active = true;
        root.classList.add('rv-editing');
        render();
        return true;
    }
    function close() {
        const was = active;
        active = false; armed = null; pending = null; drag = null;
        panel.hidden = true;
        root.classList.remove('rv-editing', 'rv-spot-armed');
        if (was && controller.state.editing) controller.setEditing(false);
    }
    function toggle() { if (active) close(); else open(); }
    /** Transport snapshot: play / Go live cleared the controller's editing flag. */
    function onTransport(s) { if (active && !s.editing) close(); }
    function destroy() {
        close();
        offField();
        fieldEl.removeEventListener('pointerdown', onFieldDown);
        fieldEl.removeEventListener('pointermove', onFieldMove);
        fieldEl.removeEventListener('pointerup', onFieldUp);
        fieldEl.removeEventListener('pointercancel', onFieldUp);
        panel.remove();
    }

    return { open, close, toggle, onTransport, render, destroy, get active() { return active; } };
}

export { createReplayEditor };
