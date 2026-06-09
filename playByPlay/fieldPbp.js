/*
 * Field Play-by-Play (spatial event entry)
 *
 * The "Field" PBP tab lets a coach tap a drawn field to record *where* each
 * throw / catch / turnover / block / pull happened, attributing players. It is
 * an alternative entry surface to the "Full" tab; both write the same Throw /
 * Turnover / Defense / Pull events into the current point's possessions.
 *
 * Canonical interaction spec: mockups/field-position/index.html and
 * mockups/field-position/FIELD_MODE.md. This module ports that mockup into
 * the real app, phase by phase.
 *
 * Coordinate system (orientation-INDEPENDENT canonical coords; see FIELD_MODE.md):
 *   - l: 0..120 along length (0 = own back line, 120 = attacking back line)
 *   - w: 0..40 across width
 *   - Endzones l 0..25 and 95..120 (depth 25). Playing field 25..95.
 *   - Red-zone lines at l = 45 and 75 (20 yd off each goal line); brick marks
 *     at those depths, centered (w = 20).
 *   Two display flips are applied only at render time:
 *     - flipAD: attacking direction (which endzone we attack)
 *     - flipHA: which sideline is Home
 *   Defaults: portrait -> Home left, attack up; landscape -> Home bottom,
 *   attack right. (Portrait mirrors the width axis vs landscape.)
 *
 * PHASE 0 (this commit): tab scaffold + static field render + chrome skeleton.
 *   - Registers under the "Field" tab (wiring in gameScreen.js / panelSystem.js).
 *   - Draws the field (endzones, goal/red-zone lines, lane guides, brick marks,
 *     Home/Away/Attack/Defend labels) with orientation-aware coord mapping and
 *     flipHA/flipAD, responsive to the panel size.
 *   - Shows the current point's players as a (non-interactive) left rail, the
 *     mode pill (derived from the shared event stream), Undo, and an in-panel
 *     orientation toggle.
 *   - NO event creation yet — pull / defense / offense / score land in later
 *     phases, reusing the shared possession helpers extracted from fullPbp.js.
 */

(function() {
    // -----------------------------------------------------------------
    // Field geometry constants (canonical yards)
    // -----------------------------------------------------------------
    const L = 120;            // field length
    const W = 40;             // field width
    const EZ = 25;            // endzone depth
    const RZ = [EZ + 20, L - EZ - 20];   // red-zone lines: 20yd off each goal line (= brick depth)
    const LANES = [W / 3, 2 * W / 3];    // home / middle / away lane guides
    const BRICK = RZ.slice();            // brick marks coincide with red-zone depth, centered

    // -----------------------------------------------------------------
    // Module-level view state (orientation + sideline/attack flips).
    // Mode + holder are NOT stored here — they are derived from the event
    // stream (shared with Full PBP) so the two tabs never disagree.
    // -----------------------------------------------------------------
    const S = {
        o: 'portrait',     // 'portrait' (in-tab) | 'landscape' (wide, in-panel for now)
        flipHA: false,     // swap which sideline is Home
        flipAD: false      // swap attacking direction / which endzone we attack
    };

    // -----------------------------------------------------------------
    // Coordinate mapping — canonical (l,w) -> percent within the field box.
    // Mirrors pct()/toField() in the mockup.
    // -----------------------------------------------------------------
    function pct(l, w) {
        const dl = S.flipAD ? (L - l) : l;
        const dw = S.flipHA ? (W - w) : w;
        // Default Home (w ~= W): LEFT in portrait, BOTTOM in landscape.
        return S.o === 'portrait'
            ? { x: ((W - dw) / W) * 100, y: ((L - dl) / L) * 100 }
            : { x: (dl / L) * 100, y: (dw / W) * 100 };
    }

    // Inverse of pct(): a fractional field position (0..1) -> canonical (l,w).
    // Used by tap/drag placement in later phases.
    function toField(fx, fy) {
        let dl, dw;
        if (S.o === 'portrait') { dw = W - fx * W; dl = L - fy * L; }
        else { dl = fx * L; dw = fy * W; }
        return { l: S.flipAD ? (L - dl) : dl, w: S.flipHA ? (W - dw) : dw };
    }

    function inAttackEZ(p) { return p.l >= L - EZ; }
    function clampLoc(l, w) {
        return { l: Math.max(1, Math.min(L - 1, l)), w: Math.max(1, Math.min(W - 1, w)) };
    }

    // -----------------------------------------------------------------
    // Mode derivation — reuse Full PBP's reconstruction so both tabs agree
    // on (mode, holder). Falls back gracefully if Full PBP isn't loaded.
    // (Phase 9 extracts this into a shared module; for now we read it.)
    // -----------------------------------------------------------------
    function reconstructState() {
        // Shared possession core (playByPlay/pbpPossession.js) — same source
        // of truth the Full tab uses, so the two never disagree.
        if (window.pbpPossession && typeof window.pbpPossession.reconstructState === 'function') {
            return window.pbpPossession.reconstructState();
        }
        const point = (typeof getLatestPoint === 'function') ? getLatestPoint() : null;
        const mode = (point && point.startingPosition === 'defense') ? 'defense' : 'offense';
        return { mode, holder: null, point };
    }

    // -----------------------------------------------------------------
    // Field rendering — static geometry for Phase 0 (no markers/arrows/disc
    // until events exist). All children are %-positioned so the field can be
    // any pixel size; orientation flips relocate the word labels.
    // -----------------------------------------------------------------
    function fieldHTML() {
        let h = '';
        const port = S.o === 'portrait';

        if (port) {
            // Endzone fills (top = attack by default, bottom = defend)
            h += `<div class="fp-ezfill" style="left:0;right:0;top:0;height:${(EZ / L) * 100}%"></div>`;
            h += `<div class="fp-ezfill" style="left:0;right:0;bottom:0;height:${(EZ / L) * 100}%"></div>`;
            // Goal lines
            [EZ, L - EZ].forEach(l => h += `<div class="fp-line" style="left:0;right:0;top:${((L - l) / L) * 100}%;height:2px"></div>`);
            // Red-zone lines
            RZ.forEach(l => h += `<div class="fp-gline rz" style="left:3%;right:3%;top:${((L - l) / L) * 100}%;height:2px"></div>`);
            // Lane guides (vertical), only across the playing field
            LANES.forEach(w => h += `<div class="fp-gline v" style="top:${(EZ / L) * 100}%;bottom:${(EZ / L) * 100}%;left:${(w / W) * 100}%;width:2px"></div>`);
        } else {
            h += `<div class="fp-ezfill" style="top:0;bottom:0;right:0;width:${(EZ / L) * 100}%"></div>`;
            h += `<div class="fp-ezfill" style="top:0;bottom:0;left:0;width:${(EZ / L) * 100}%"></div>`;
            [EZ, L - EZ].forEach(l => h += `<div class="fp-line" style="top:0;bottom:0;left:${(l / L) * 100}%;width:2px"></div>`);
            RZ.forEach(l => h += `<div class="fp-gline rz v" style="top:3%;bottom:3%;left:${(l / L) * 100}%;width:2px"></div>`);
            LANES.forEach(w => h += `<div class="fp-gline" style="left:${(EZ / L) * 100}%;right:${(EZ / L) * 100}%;top:${(w / W) * 100}%;height:2px"></div>`);
        }

        // Word labels positioned by canonical coords so flips relocate them.
        // Each is long-pressable (data-flip) to bring up its flip toast (wired
        // in a later phase; the markup is in place now).
        const lab = (txt, l, w, flip, cls) => {
            const p = pct(l, w);
            const vert = (port && flip === 'ha') ? ';writing-mode:vertical-rl' : '';
            return `<div class="${cls} fp-flbl" data-flip="${flip}" style="left:${p.x}%;top:${p.y}%${vert}">${txt}</div>`;
        };
        h += lab('Attack', L - EZ / 2, W / 2, 'ad', 'fp-ezlabel');
        h += lab('Defend', EZ / 2, W / 2, 'ad', 'fp-ezlabel');
        h += lab('Home', L / 2, W * 0.93, 'ha', 'fp-sidelbl');
        h += lab('Away', L / 2, W * 0.07, 'ha', 'fp-sidelbl');
        BRICK.forEach(l => {
            const p = pct(l, W / 2);
            h += `<div class="fp-brick" style="left:${p.x}%;top:${p.y}%">&times;</div>`;
        });

        return h;
    }

    // Player rail (Phase 0: static chips for the current point's players).
    function playerRailHTML(state) {
        const point = state.point;
        const hasPoint = !!(point && point.players && point.players.length);
        if (!hasPoint) {
            return `<div class="fp-rail-placeholder">Start a point to begin entering events.</div>`;
        }
        const holder = state.holder;
        const names = point.players;
        let html = names.map(name => {
            const player = (typeof getPlayerFromName === 'function') ? getPlayerFromName(name) : null;
            if (!player) return '';
            return chipHTML(player, holder && holder.name === name);
        }).join('');
        // Unknown chip (dashed "?") — available on O and D.
        const unknown = (typeof getPlayerFromName === 'function') ? getPlayerFromName(UNKNOWN_PLAYER) : null;
        if (unknown) html += chipHTML(unknown, false, true);
        return html;
    }

    function chipHTML(player, isHolder, isUnknown) {
        const cls = ['fp-chip'];
        if (isUnknown) cls.push('unknown');
        if (isHolder) cls.push('holder');
        const lead = isUnknown
            ? `<span class="fp-umark">?</span>`
            : (player.number != null ? `<span class="fp-num">${player.number}</span>` : '');
        const label = isUnknown ? 'Unknown' : player.name;
        return `<div class="${cls.join(' ')}" data-pid="${player.id || ''}">${lead}<span class="fp-nm">${label}</span></div>`;
    }

    function modeLabel(mode) { return mode === 'offense' ? 'OFFENSE' : 'DEFENSE'; }

    // -----------------------------------------------------------------
    // Panel construction
    // -----------------------------------------------------------------
    function createPlayByPlayFieldPanel() {
        const panel = document.createElement('div');
        panel.id = 'panel-playByPlayField';
        panel.className = 'game-panel panel-playByPlay panel-playByPlayField';

        const titleBar = window.createPanelTitleBar
            ? window.createPanelTitleBar({ panelId: 'playByPlayField', title: 'Field', showDragHandle: false })
            : (() => {
                const tb = document.createElement('div');
                tb.className = 'panel-title-bar';
                tb.innerHTML = '<span class="panel-title">Field</span>';
                return tb;
            })();
        panel.appendChild(titleBar);

        const content = document.createElement('div');
        content.className = 'panel-content field-pbp-content';
        content.id = 'panel-playByPlayField-content';
        panel.appendChild(content);

        return panel;
    }

    // -----------------------------------------------------------------
    // Render
    // -----------------------------------------------------------------
    function render() {
        const content = document.getElementById('panel-playByPlayField-content');
        if (!content) return;

        const state = reconstructState();
        const inPoint = (typeof isPointInProgress === 'function') && isPointInProgress();

        // Role-disabled fading, mirroring Full PBP.
        const panel = document.getElementById('panel-playByPlayField');
        if (panel) {
            const canEdit = (typeof window.canEditPlayByPlay === 'function') ? window.canEditPlayByPlay() : true;
            panel.classList.toggle('role-disabled', !canEdit);
        }

        const mode = state.mode;
        const fieldBox = `<div class="fp-fieldwrap"><div class="fp-field" id="fpField">${fieldHTML()}</div></div>`;
        const modeColPlaceholder = `<div class="fp-modcol-label">Last throw was a:</div><div class="fp-modcol-sub"><i>no play yet</i></div>`;

        content.dataset.o = S.o;
        content.dataset.mode = mode;

        content.innerHTML = `
            <div class="fp-actionrow">
                <span class="fp-modepill ${mode}">${modeLabel(mode)}</span>
                <button class="fp-iconbtn" id="fpExpandBtn" title="${S.o === 'portrait' ? 'Wide field' : 'Tall field'}"><i class="fas fa-${S.o === 'portrait' ? 'expand' : 'compress'}"></i></button>
                <span class="fp-actionrow-spacer"></span>
                <button class="fp-undo" id="fpUndoBtn" title="Undo last event"><i class="fas fa-undo"></i><span>Undo</span></button>
            </div>
            <div class="fp-play">
                <div class="fp-prow">
                    <div class="fp-sidebar">
                        <div class="fp-rail">${playerRailHTML(state)}</div>
                        <div class="fp-modsep"></div>
                        <div class="fp-modcol">${modeColPlaceholder}</div>
                    </div>
                    ${fieldBox}
                </div>
                <div class="fp-statusbar">${statusText(state, inPoint)}</div>
                <div class="fp-events"></div>
                <button class="fp-mic" title="Narration mic">&#127908;</button>
            </div>
        `;

        wireDynamic();
    }

    function statusText(state, inPoint) {
        if (!inPoint) return 'Between points — start a point to begin.';
        const holder = state.holder;
        if (state.mode === 'defense') return 'On defense';
        return holder ? `<b>${holder.name}</b> has the disc` : 'Pick up / who has the disc?';
    }

    // -----------------------------------------------------------------
    // Wiring
    // -----------------------------------------------------------------
    function wireDynamic() {
        const expandBtn = document.getElementById('fpExpandBtn');
        if (expandBtn) expandBtn.onclick = () => { S.o = (S.o === 'portrait') ? 'landscape' : 'portrait'; render(); };

        const undoBtn = document.getElementById('fpUndoBtn');
        if (undoBtn) undoBtn.onclick = handleUndo;
    }

    // Undo delegates to the global undoEvent() so the Field tab shares all the
    // score-rollback / possession-cleanup / point-removal logic with the other
    // tabs (same approach as Full PBP).
    function handleUndo() {
        const canEdit = (typeof window.canEditPlayByPlay === 'function') ? window.canEditPlayByPlay() : true;
        if (!canEdit) {
            if (typeof showControllerToast === 'function') {
                showControllerToast('Only the Active Coach can record events', 'warning', 2200);
            }
            return;
        }
        if (typeof undoEvent === 'function') undoEvent();
        render();
    }

    // Stable wiring (called on tab entry). Currently nothing persists across
    // re-renders, but keep the hook so panelSystem can call it like fullPbp's.
    function wireEvents() { /* no-op for Phase 0 */ }

    // -----------------------------------------------------------------
    // Init
    // -----------------------------------------------------------------
    function init() {
        render();
        if (window.narrationEventBus) {
            window.narrationEventBus.subscribe('eventAdded', render);
            window.narrationEventBus.subscribe('eventAmended', render);
            window.narrationEventBus.subscribe('eventRetracted', render);
            window.narrationEventBus.subscribe('pointChanged', render);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 0);
    }

    // -----------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------
    window.fieldPbp = {
        createPlayByPlayFieldPanel,
        render,
        wireEvents,
        // Inspection helpers for devtools while iterating.
        _state: S,
        _pct: pct,
        _toField: toField
    };
})();
