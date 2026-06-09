/*
 * Field Play-by-Play (spatial event entry)
 *
 * The "Field" PBP tab lets a coach tap a drawn field to record *where* each
 * throw / catch / turnover / block / pull happened, attributing players. It is
 * an alternative entry surface to the "Full" tab; both write the same Throw /
 * Turnover / Defense / Pull events into the current point's possessions via the
 * shared possession core (playByPlay/pbpPossession.js).
 *
 * Canonical interaction spec: mockups/field-position/index.html and
 * mockups/field-position/FIELD_MODE.md.
 *
 * Coordinate system (orientation-INDEPENDENT canonical coords):
 *   - l: 0..120 along length (0 = own back line, 120 = attacking back line)
 *   - w: 0..40 across width
 *   - Endzones l 0..25 (Defend) and 95..120 (Attack). Playing field 25..95.
 *   - Red-zone / brick lines at l = 45 and 75. Two display flips (flipAD /
 *     flipHA) are applied only at render time.
 *
 * Phases done here:
 *   0: tab scaffold + static field render.
 *   3: PULL (D-point start) — pick puller, hangtime stopwatch, tap the field
 *      to place the landing (or Brick); records a Pull and drops into defense.
 *      Also: Start Point button (between points), and field event rendering
 *      (arrows / markers / disc) reused by all later phases.
 *
 * Still to come: defense entry (4), offense entry + drag gestures (5),
 * score dialog (6), modifier strip / orientation flips / polish (7).
 */

(function() {
    // -----------------------------------------------------------------
    // Field geometry constants (canonical yards)
    // -----------------------------------------------------------------
    const L = 120, W = 40, EZ = 25;
    const RZ = [EZ + 20, L - EZ - 20];   // 45, 75
    const LANES = [W / 3, 2 * W / 3];
    const BRICK = RZ.slice();
    const VISIBLE = 4;                    // recent markers/arrows kept solid

    // -----------------------------------------------------------------
    // View + interaction state. Mode/holder are derived from the event
    // stream (shared core), never stored here.
    // -----------------------------------------------------------------
    const S = {
        o: 'portrait',
        flipHA: false,
        flipAD: false,
        // pull flow
        pulling: false,
        puller: null,       // Player object | null
        pullRunning: false,
        pullStart: 0,
        pullMs: null,
        pullMods: []         // subset of PMODS
    };
    let pullTimer = null;

    const PMODS = [
        { label: 'Roller', prop: 'roller' },
        { label: 'OI', prop: 'oi' },
        { label: 'IO', prop: 'io' }
    ];

    // -----------------------------------------------------------------
    // Coordinate mapping (mirrors the mockup's pct()/toField()).
    // -----------------------------------------------------------------
    function pct(l, w) {
        const dl = S.flipAD ? (L - l) : l;
        const dw = S.flipHA ? (W - w) : w;
        return S.o === 'portrait'
            ? { x: ((W - dw) / W) * 100, y: ((L - dl) / L) * 100 }
            : { x: (dl / L) * 100, y: (dw / W) * 100 };
    }
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
    // State derivation (shared possession core).
    // -----------------------------------------------------------------
    function reconstructState() {
        if (window.pbpPossession && typeof window.pbpPossession.reconstructState === 'function') {
            return window.pbpPossession.reconstructState();
        }
        const point = (typeof getLatestPoint === 'function') ? getLatestPoint() : null;
        const mode = (point && point.startingPosition === 'defense') ? 'defense' : 'offense';
        return { mode, holder: null, point };
    }

    function pointEvents(point) {
        const out = [];
        if (point && point.possessions) {
            point.possessions.forEach(poss => (poss.events || []).forEach(e => out.push(e)));
        }
        return out;
    }
    function pointHasPull(point) {
        return pointEvents(point).some(e => e.type === 'Pull');
    }
    function lastLocatedEvent(point) {
        const evs = pointEvents(point);
        for (let i = evs.length - 1; i >= 0; i--) {
            if (evs[i] && evs[i].to) return evs[i];
        }
        return null;
    }

    // -----------------------------------------------------------------
    // Field rendering: static geometry + located-event arrows/markers/disc.
    // -----------------------------------------------------------------
    function fieldHTML(state) {
        let h = '';
        const port = S.o === 'portrait';

        if (port) {
            h += `<div class="fp-ezfill" style="left:0;right:0;top:0;height:${(EZ / L) * 100}%"></div>`;
            h += `<div class="fp-ezfill" style="left:0;right:0;bottom:0;height:${(EZ / L) * 100}%"></div>`;
            [EZ, L - EZ].forEach(l => h += `<div class="fp-line" style="left:0;right:0;top:${((L - l) / L) * 100}%;height:2px"></div>`);
            RZ.forEach(l => h += `<div class="fp-gline rz" style="left:3%;right:3%;top:${((L - l) / L) * 100}%;height:2px"></div>`);
            LANES.forEach(w => h += `<div class="fp-gline v" style="top:${(EZ / L) * 100}%;bottom:${(EZ / L) * 100}%;left:${(w / W) * 100}%;width:2px"></div>`);
        } else {
            h += `<div class="fp-ezfill" style="top:0;bottom:0;right:0;width:${(EZ / L) * 100}%"></div>`;
            h += `<div class="fp-ezfill" style="top:0;bottom:0;left:0;width:${(EZ / L) * 100}%"></div>`;
            [EZ, L - EZ].forEach(l => h += `<div class="fp-line" style="top:0;bottom:0;left:${(l / L) * 100}%;width:2px"></div>`);
            RZ.forEach(l => h += `<div class="fp-gline rz v" style="top:3%;bottom:3%;left:${(l / L) * 100}%;width:2px"></div>`);
            LANES.forEach(w => h += `<div class="fp-gline" style="left:${(EZ / L) * 100}%;right:${(EZ / L) * 100}%;top:${(w / W) * 100}%;height:2px"></div>`);
        }

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

        // Located events: arrows + markers (older fade), then the disc.
        const evs = pointEvents(state.point);
        let svg = `<svg class="fp-arrows" viewBox="0 0 100 100" preserveAspectRatio="none"><defs>`
            + `<marker id="fpah" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">`
            + `<path d="M0,0 L5,2.5 L0,5 z" fill="#fff"/></marker></defs>`;
        evs.forEach((e, i) => {
            if (!e.from || !e.to) return;
            const rec = evs.length - 1 - i, op = rec < VISIBLE ? (1 - rec * 0.2) : 0.1;
            const a = pct(e.from.l, e.from.w), b = pct(e.to.l, e.to.w);
            const dash = e.type === 'Pull' ? 'stroke-dasharray="3 2"' : '';
            svg += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${arrowColor(e)}" stroke-width="0.8" marker-end="url(#fpah)" ${dash} vector-effect="non-scaling-stroke" opacity="${op.toFixed(2)}"/>`;
        });
        svg += `</svg>`;
        h += svg;

        evs.forEach((e, i) => {
            if (!e.to) return;
            const rec = evs.length - 1 - i, op = rec < VISIBLE ? (1 - rec * 0.2) : 0.1;
            const p = pct(e.to.l, e.to.w);
            const m = markerStyle(e, i);
            h += `<div class="fp-marker ${m.cls}" style="left:${p.x}%;top:${p.y}%;opacity:${op.toFixed(2)}">${m.glyph}</div>`;
        });

        const le = lastLocatedEvent(state.point);
        if (le) {
            const d = pct(le.to.l, le.to.w);
            h += `<div class="fp-disc" style="left:${d.x}%;top:${d.y}%"></div>`;
        }

        return h;
    }

    function arrowColor(e) {
        if (e.type === 'Pull') return '#e5e7eb';
        if (e.type === 'Throw') return e.score_flag ? '#34d399' : '#bfdbfe';
        if (e.type === 'Turnover') return '#fca5a5';
        if (e.type === 'Defense') return '#34d399';
        return '#bfdbfe';
    }
    function markerStyle(e, idx) {
        if (e.type === 'Pull') return { cls: 'pull', glyph: 'P' };
        if (e.type === 'Throw') return e.score_flag ? { cls: 'score', glyph: 'G' } : { cls: 'completion', glyph: String(idx + 1) };
        if (e.type === 'Turnover') return { cls: 'turn', glyph: '✗' };
        if (e.type === 'Defense') {
            if (e.Callahan_flag) return { cls: 'score', glyph: 'C' };
            if (e.interception_flag) return { cls: 'block', glyph: 'I' };
            if (e.stall_flag) return { cls: 'block', glyph: 'S' };
            return { cls: 'block', glyph: 'D' };
        }
        return { cls: 'turn', glyph: '?' };
    }

    // -----------------------------------------------------------------
    // Rail (players / puller picker) + chips
    // -----------------------------------------------------------------
    function playerRailHTML(state, inPoint) {
        const point = state.point;
        const hasPoint = !!(point && point.players && point.players.length);
        if (!hasPoint) {
            return `<div class="fp-rail-placeholder">Start a point to begin entering events.</div>`;
        }

        let lead = '';
        if (S.pulling) lead = `<div class="fp-slotlbl">Pick Puller:</div>`;

        const holder = state.holder;
        let html = lead + point.players.map(name => {
            const player = (typeof getPlayerFromName === 'function') ? getPlayerFromName(name) : null;
            if (!player) return '';
            const isHolder = !!(holder && holder.name === name);
            const isPuller = !!(S.pulling && S.puller && S.puller.name === name);
            return chipHTML(player, { holder: isHolder, armed: isPuller });
        }).join('');
        const unknown = (typeof getPlayerFromName === 'function') ? getPlayerFromName(UNKNOWN_PLAYER) : null;
        if (unknown) html += chipHTML(unknown, { unknown: true, armed: !!(S.pulling && S.puller && S.puller.name === UNKNOWN_PLAYER) });
        return html;
    }

    function chipHTML(player, opts) {
        opts = opts || {};
        const cls = ['fp-chip'];
        if (opts.unknown) cls.push('unknown');
        if (opts.holder) cls.push('holder');
        if (opts.armed) cls.push('armed');
        const lead = opts.unknown
            ? `<span class="fp-umark">?</span>`
            : (player.number != null ? `<span class="fp-num">${player.number}</span>` : '');
        const label = opts.unknown ? 'Unknown' : player.name;
        return `<div class="${cls.join(' ')}" data-pname="${player.name}">${lead}<span class="fp-nm">${label}</span></div>`;
    }

    // -----------------------------------------------------------------
    // Events bar + modifier column + status (mode-dependent)
    // -----------------------------------------------------------------
    function hangLabel() {
        if (S.pullRunning) return '⏱ ' + ((performance.now() - S.pullStart) / 1000).toFixed(1) + 's — tap on landing';
        if (S.pullMs) return '⏱ ' + (S.pullMs / 1000).toFixed(1) + 's hang';
        return '⏱ Tap on release';
    }

    function eventsHTML(state, inPoint) {
        if (S.pulling) {
            return `<button class="fp-ebtn pullhang" data-pull="hang">${hangLabel()}</button>`
                + `<button class="fp-ebtn pullbrick" data-pull="brick">Brick</button>`;
        }
        // Offense / defense action buttons land in Phases 4–5.
        return '';
    }

    function modColHTML(state) {
        if (S.pulling) {
            const sub = S.puller ? S.puller.name : '—';
            return `<div class="fp-modcol-label">This pull:</div><div class="fp-modcol-sub">${sub}</div>`
                + PMODS.map(m => `<button class="fp-modbtn ${S.pullMods.includes(m.label) ? 'on' : ''}" data-pmod="${m.label}">${m.label}</button>`).join('');
        }
        // Modifier strip for the last play lands in Phase 7.
        return `<div class="fp-modcol-label">Last throw was a:</div><div class="fp-modcol-sub"><i>no play yet</i></div>`;
    }

    function statusText(state, inPoint) {
        if (S.pulling) {
            const who = S.puller ? `<b>${S.puller.name}</b> pulls — ` : '';
            return `${who}time the hang, then tap where it landed (or Brick)`;
        }
        if (!inPoint) return 'Between points — start a point to begin.';
        if (state.mode === 'defense') return 'On defense';
        const holder = state.holder;
        return holder ? `<b>${holder.name}</b> has the disc` : 'Pick up / who has the disc?';
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

        const panel = document.getElementById('panel-playByPlayField');
        if (panel) {
            const canEdit = (typeof window.canEditPlayByPlay === 'function') ? window.canEditPlayByPlay() : true;
            panel.classList.toggle('role-disabled', !canEdit);
        }

        const mode = state.mode;
        const fieldBox = `<div class="fp-fieldwrap"><div class="fp-field" id="fpField">${fieldHTML(state)}</div></div>`;

        // Action-row left slot: Start Point (between points, not pulling),
        // a PULL pill while pulling, else the mode pill.
        let leftSlot;
        if (S.pulling) {
            leftSlot = `<span class="fp-modepill pull">PULL</span>`;
        } else if (!inPoint) {
            leftSlot = `<button class="fp-start-point-btn" id="fpStartPointBtn">Start Point</button>`;
        } else {
            leftSlot = `<span class="fp-modepill ${mode}">${modeLabel(mode)}</span>`;
        }

        content.dataset.o = S.o;
        content.dataset.mode = S.pulling ? 'pull' : mode;

        content.innerHTML = `
            <div class="fp-actionrow">
                ${leftSlot}
                <button class="fp-iconbtn" id="fpExpandBtn" title="${S.o === 'portrait' ? 'Wide field' : 'Tall field'}"><i class="fas fa-${S.o === 'portrait' ? 'expand' : 'compress'}"></i></button>
                <span class="fp-actionrow-spacer"></span>
                <button class="fp-undo" id="fpUndoBtn" title="Undo last event"><i class="fas fa-undo"></i><span>Undo</span></button>
            </div>
            <div class="fp-play">
                <div class="fp-prow">
                    <div class="fp-sidebar">
                        <div class="fp-rail">${playerRailHTML(state, inPoint)}</div>
                        <div class="fp-modsep"></div>
                        <div class="fp-modcol">${modColHTML(state)}</div>
                    </div>
                    ${fieldBox}
                </div>
                <div class="fp-statusbar">${statusText(state, inPoint)}</div>
                <div class="fp-events">${eventsHTML(state, inPoint)}</div>
                <button class="fp-mic" title="Narration mic">&#127908;</button>
            </div>
        `;

        wireDynamic();
    }

    // -----------------------------------------------------------------
    // Pull flow
    // -----------------------------------------------------------------

    /**
     * Enter the in-field pull flow. Called by pointManagement.startNextPoint
     * when a D-point starts and the Field tab is the active surface (it
     * suppresses the modal pull dialog in that case). Guarded so we never
     * double-pull a point.
     */
    function beginPull() {
        const point = (typeof getLatestPoint === 'function') ? getLatestPoint() : null;
        if (!point || pointHasPull(point)) return;
        S.pulling = true;
        S.puller = null;
        S.pullRunning = false;
        S.pullMs = null;
        S.pullMods = [];
        if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
        render();
    }

    function toggleHang() {
        if (!requireActiveCoach()) return;
        if (S.pullRunning) {
            S.pullRunning = false;
            S.pullMs = performance.now() - S.pullStart;
            if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
            render();
        } else {
            S.pullRunning = true;
            S.pullStart = performance.now();
            S.pullMs = 0;
            if (pullTimer) clearInterval(pullTimer);
            pullTimer = setInterval(() => {
                const b = document.querySelector('#panel-playByPlayField .fp-ebtn.pullhang');
                if (b) b.textContent = '⏱ ' + ((performance.now() - S.pullStart) / 1000).toFixed(1) + 's — tap on landing';
            }, 100);
            render();
        }
    }

    function togglePullMod(label) {
        const k = S.pullMods.indexOf(label);
        if (k >= 0) S.pullMods.splice(k, 1); else S.pullMods.push(label);
        render();
    }

    /**
     * Finish the pull: place the landing (or Brick), stopping the hang clock
     * if it's still running, and record a Pull event. Drops into defense.
     */
    function placePull(l, w, brick) {
        if (!requireActiveCoach()) return;
        if (S.pullRunning) {
            S.pullMs = performance.now() - S.pullStart;
            S.pullRunning = false;
            if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
        }
        // We pull from our defending goal line (canonical Defend end = l 0..25,
        // goal line at l = EZ). Brick goes to the brick mark nearest that line.
        const from = { l: EZ, w: W / 2 };
        const to = brick ? { l: BRICK[0], w: W / 2 } : clampLoc(l, w);

        const opts = { from, to, hang: (typeof S.pullMs === 'number' && S.pullMs > 0) ? S.pullMs : null, brick: !!brick };
        S.pullMods.forEach(label => {
            const m = PMODS.find(pm => pm.label === label);
            if (m) opts[m.prop] = true;
        });

        window.pbpPossession.createPull(S.puller || null, opts);

        S.pulling = false;
        S.puller = null;
        S.pullRunning = false;
        S.pullMs = null;
        S.pullMods = [];
        if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
        render();
    }

    // -----------------------------------------------------------------
    // Interaction handlers
    // -----------------------------------------------------------------
    function requireActiveCoach() {
        const ok = (typeof window.canEditPlayByPlay === 'function') ? window.canEditPlayByPlay() : true;
        if (!ok && typeof showControllerToast === 'function') {
            showControllerToast('Only the Active Coach can record events', 'warning', 2200);
        }
        return ok;
    }

    function playerByName(name) {
        return (typeof getPlayerFromName === 'function') ? getPlayerFromName(name) : null;
    }

    function handleChipTap(name) {
        if (!requireActiveCoach()) return;
        if (S.pulling) {
            const p = playerByName(name);
            S.puller = (S.puller && S.puller.name === name) ? null : p;
            render();
            return;
        }
        // Offense/defense chip taps land in Phases 4–5.
    }

    function handleFieldTap(loc) {
        if (S.pulling) { placePull(loc.l, loc.w, false); return; }
        // Offense/defense field placement lands in Phases 4–5.
    }

    function handleUndo() {
        if (!requireActiveCoach()) return;
        // Bail out of an in-progress pull cleanly rather than undoing a prior
        // event when the coach hasn't placed the pull yet.
        if (S.pulling && S.pullMs === null && !S.puller) {
            S.pulling = false;
            if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
            render();
            return;
        }
        if (typeof undoEvent === 'function') undoEvent();
        S.pulling = false;
        S.puller = null;
        S.pullMs = null;
        S.pullMods = [];
        if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
        render();
    }

    function handleStartPoint() {
        if (typeof handlePanelStartPoint === 'function') handlePanelStartPoint();
        else if (typeof startNextPoint === 'function') startNextPoint();
    }

    // -----------------------------------------------------------------
    // Wiring (per-render; elements are rebuilt each render)
    // -----------------------------------------------------------------
    function wireDynamic() {
        const root = document.getElementById('panel-playByPlayField-content');
        if (!root) return;

        const expandBtn = root.querySelector('#fpExpandBtn');
        if (expandBtn) expandBtn.onclick = () => { S.o = (S.o === 'portrait') ? 'landscape' : 'portrait'; render(); };

        const undoBtn = root.querySelector('#fpUndoBtn');
        if (undoBtn) undoBtn.onclick = handleUndo;

        const startBtn = root.querySelector('#fpStartPointBtn');
        if (startBtn) startBtn.onclick = handleStartPoint;

        // Player / puller chips
        root.querySelectorAll('.fp-chip[data-pname]').forEach(chip => {
            chip.onclick = () => handleChipTap(chip.dataset.pname);
        });

        // Pull hang/brick buttons
        root.querySelectorAll('.fp-ebtn[data-pull]').forEach(b => {
            b.onclick = () => { b.dataset.pull === 'hang' ? toggleHang() : placePull(0, 0, true); };
        });

        // Pull modifier tags
        root.querySelectorAll('.fp-modbtn[data-pmod]').forEach(b => {
            b.onclick = () => togglePullMod(b.dataset.pmod);
        });

        // Field tap → canonical coords. Click is sufficient for placement in
        // these phases; drag (pegman / marker fine-tune) lands in Phase 5.
        const field = root.querySelector('#fpField');
        if (field) {
            field.onclick = (e) => {
                const r = field.getBoundingClientRect();
                const fx = (e.clientX - r.left) / r.width;
                const fy = (e.clientY - r.top) / r.height;
                if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
                handleFieldTap(toField(fx, fy));
            };
        }
    }

    function wireEvents() { /* stable wiring handled per-render in wireDynamic */ }

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
        beginPull,
        // devtools helpers
        _state: S,
        _pct: pct,
        _toField: toField
    };
})();
