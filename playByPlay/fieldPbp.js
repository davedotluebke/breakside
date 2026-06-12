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
    // Field geometry (canonical yards). Width and the playing field proper are
    // fixed; endzone depth (EZ) comes from Advanced Settings (default 20 yd,
    // USAU; some leagues use 25). L and the red-zone/brick lines derive from
    // EZ, so they're refreshed from the setting on every render.
    //
    // NOTE: stored event coordinates are in these canonical yards, so changing
    // the endzone depth re-scales the field a past game was recorded in. This
    // is fine for the (new, data-free) Field tab; if real spatial data later
    // needs to survive a depth change, persist EZ per game and map on read.
    // -----------------------------------------------------------------
    const W = 40;                         // field width (fixed)
    const PLAYING = 70;                   // playing field proper, between goal lines (fixed)
    const LANES = [W / 3, 2 * W / 3];
    const VISIBLE = 4;                    // recent markers/arrows kept solid
    let EZ = 20;                          // endzone depth (refreshed from settings)
    let L = PLAYING + 2 * EZ;             // total length
    let RZ = [EZ + 20, L - EZ - 20];      // red-zone / brick lines (20 yd off each goal line)
    let BRICK = RZ.slice();

    function refreshGeometry() {
        const y = (window.advancedSettings && typeof window.advancedSettings.getEndzoneYards === 'function')
            ? window.advancedSettings.getEndzoneYards() : 20;
        EZ = (Number.isFinite(y) && y > 0) ? y : 20;
        L = PLAYING + 2 * EZ;
        RZ = [EZ + 20, L - EZ - 20];
        BRICK = RZ.slice();
    }

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
        pullMods: [],        // subset of PMODS
        // defense flow
        dPlacing: null,      // 'block'|'interception'|'stall'|'callahan' | null
        dMods: [],           // subset of DMODS (Layout / Sky)
        // shared placement: a player armed (picked) awaiting a field tap
        armed: null,         // Player object | null
        // offense flow
        pending: null,       // null | 'drop' | 'throwaway' | 'score'
        // Manual holder override — set when the coach picks who picked up the
        // disc (start of possession / after a block) where the event stream
        // has no holder. Cleared whenever a real event is added or undone, so
        // the derived state stays the source of truth otherwise.
        manualHolder: null,  // Player object | null
        pickupLoc: null      // {l,w} | null — where the pickup happened (next throw's from)
    };
    let pullTimer = null;

    const PMODS = [
        { label: 'Roller', prop: 'roller' },
        { label: 'OI', prop: 'oi' },
        { label: 'IO', prop: 'io' }
    ];
    const DMODS = [
        { label: 'Layout', prop: 'layout' },
        { label: 'Sky', prop: 'sky' }
    ];
    // D actions shown in the player slot until one is chosen.
    const DTYPES = [
        { type: 'block', label: 'Block' },
        { type: 'interception', label: 'Interception' },
        { type: 'stall', label: 'Stall' },
        { type: 'callahan', label: 'Callahan' }
    ];
    const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';

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

    /**
     * Effective holder = event-stream-derived holder, falling back to the
     * manual pickup override when derivation says "nobody" (start of
     * possession, after a block, after the pull).
     */
    function effectiveHolder(state) {
        return state.holder || S.manualHolder;
    }

    /**
     * Where the disc currently is, for use as a throw's `from`: an explicit
     * pickup spot if one was just recorded, else the last located event's
     * landing point, else null (no arrow drawn for the first throw).
     */
    function discLoc(state) {
        if (S.pickupLoc) return S.pickupLoc;
        const le = lastLocatedEvent(state.point);
        return le ? le.to : null;
    }

    /** Clear the transient offense-entry UI state after any committed event. */
    function clearEntryState() {
        S.armed = null;
        S.pending = null;
        S.manualHolder = null;
        S.pickupLoc = null;
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
            // The most recent VISIBLE markers stay draggable for fine-tuning
            // (drag re-anchors the adjacent throw); older ones fade + freeze.
            const dragAttr = rec < VISIBLE ? ` data-mkidx="${i}"` : '';
            h += `<div class="fp-marker ${m.cls}"${dragAttr} style="left:${p.x}%;top:${p.y}%;opacity:${op.toFixed(2)}">${m.glyph}</div>`;
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

        // Defense, before choosing a D action: the slot shows the four D
        // actions instead of player chips.
        if (!S.pulling && inPoint && state.mode === 'defense' && !S.dPlacing) {
            return DTYPES.map(d =>
                `<div class="fp-dtypebtn" data-dtype="${d.type}">${d.label}</div>`
            ).join('');
        }

        let lead = '';
        if (S.pulling) {
            lead = `<div class="fp-slotlbl">Pick Puller:</div>`;
        } else if (S.dPlacing) {
            // Placing a D: a cancel chip leads the defender picker.
            lead = `<div class="fp-dcancel" data-dcancel="1">✕ ${cap(S.dPlacing)}</div>`;
        }

        const holder = effectiveHolder(state);
        const armedName = S.pulling ? (S.puller && S.puller.name)
            : (S.armed && S.armed.name);
        let html = lead + point.players.map(name => {
            const player = (typeof getPlayerFromName === 'function') ? getPlayerFromName(name) : null;
            if (!player) return '';
            const isHolder = !!(holder && holder.name === name);
            const isArmed = !!(armedName && armedName === name);
            return chipHTML(player, { holder: isHolder, armed: isArmed });
        }).join('');
        const unknown = (typeof getPlayerFromName === 'function') ? getPlayerFromName(UNKNOWN_PLAYER) : null;
        if (unknown) html += chipHTML(unknown, { unknown: true, armed: armedName === UNKNOWN_PLAYER });
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
        if (inPoint && state.mode === 'defense') {
            return `<button class="fp-ebtn theyturn" data-act="theyturn">They turnover</button>`
                + `<button class="fp-ebtn theyscore" data-act="theyscore">They score</button>`
                + `<button class="fp-ebtn more" data-act="more">⋯ more</button>`;
        }
        if (inPoint && state.mode === 'offense') {
            const on = a => S.pending === a ? ' on' : '';
            return `<button class="fp-ebtn drop${on('drop')}" data-act="drop">Drop</button>`
                + `<button class="fp-ebtn throwaway${on('throwaway')}" data-act="throwaway">Throwaway</button>`
                + `<button class="fp-ebtn score${on('score')}" data-act="score">Score</button>`
                + `<button class="fp-ebtn more" data-act="more">⋯ more</button>`;
        }
        return '';
    }

    function modColHTML(state) {
        if (S.pulling) {
            const sub = S.puller ? S.puller.name : '—';
            return `<div class="fp-modcol-label">This pull:</div><div class="fp-modcol-sub">${sub}</div>`
                + PMODS.map(m => `<button class="fp-modbtn ${S.pullMods.includes(m.label) ? 'on' : ''}" data-pmod="${m.label}">${m.label}</button>`).join('');
        }
        if (S.dPlacing) {
            // Pre-label the D being placed (before player/spot are set).
            return `<div class="fp-modcol-label">Last D was a:</div><div class="fp-modcol-sub">${cap(S.dPlacing)}</div>`
                + DMODS.map(m => `<button class="fp-modbtn ${S.dMods.includes(m.label) ? 'on' : ''}" data-dmod="${m.label}">${m.label}</button>`).join('');
        }
        // Modifier chips for the last completed play land in Phase 7; for now
        // the column names the last play so the coach can see what's tagged.
        let label = 'Last throw was a:';
        let sub = '<i>no play yet</i>';
        const le = (window.pbpPossession && state.point)
            ? window.pbpPossession.findLastEditableEvent(state.point) : null;
        if (le) {
            const nm = p => (p && p.name === UNKNOWN_PLAYER) ? 'Unknown' : (p && p.name) || '';
            if (le.type === 'Defense') {
                label = 'Last D was a:';
                const kind = le.Callahan_flag ? 'Callahan' : le.interception_flag ? 'interception'
                    : le.stall_flag ? 'stall' : le.unforcedError_flag ? 'their turnover' : 'block';
                sub = `${nm(le.defender) ? nm(le.defender) + ' — ' : ''}${kind}`;
            } else if (le.type === 'Turnover') {
                sub = le.drop_flag ? `${nm(le.receiver)} (drop)` : `${nm(le.thrower)} (throwaway)`;
            } else {
                sub = `${nm(le.thrower)} to ${nm(le.receiver)}${le.score_flag ? ' — goal!' : ''}`;
            }
        }
        return `<div class="fp-modcol-label">${label}</div><div class="fp-modcol-sub">${sub}</div>`;
    }

    function statusText(state, inPoint) {
        if (S.pulling) {
            const who = S.puller ? `<b>${S.puller.name}</b> pulls — ` : '';
            return `${who}time the hang, then tap where it landed (or Brick)`;
        }
        if (!inPoint) return 'Between points — start a point to begin.';
        if (state.mode === 'defense') {
            if (S.armed && S.dPlacing) return `Tap where <b>${S.armed.name}</b> made the ${S.dPlacing}`;
            if (S.dPlacing) return `<b>${cap(S.dPlacing)}</b> — tap the spot &amp; pick the defender`;
            return 'On defense — pick a D action';
        }
        // Offense
        if (S.pending === 'throwaway') return 'Tap where the throwaway landed';
        if (S.armed) {
            const suffix = S.pending === 'drop' ? ' (drop)' : S.pending === 'score' ? ' (score)' : '';
            return `Tap where <b>${S.armed.name}</b> caught it${suffix}`;
        }
        if (S.pending === 'drop') return 'Tap the drop spot, then pick who dropped it';
        if (S.pending === 'score') return '<b>Score</b> — pick the receiver, then the spot';
        const holder = effectiveHolder(state);
        return holder ? `<b>${holder.name}</b> has the disc`
            : 'Who picked it up? Tap the player (or drag them to the spot)';
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

        refreshGeometry();   // pick up the current endzone-depth setting
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
        const p = playerByName(name);
        if (S.pulling) {
            S.puller = (S.puller && S.puller.name === name) ? null : p;
            render();
            return;
        }
        if (S.dPlacing) {
            // Arm/disarm the defender for the D being placed.
            S.armed = (S.armed && S.armed.name === name) ? null : p;
            render();
            return;
        }
        // Offense
        const state = reconstructState();
        if (state.mode !== 'offense') return;
        const holder = effectiveHolder(state);
        if (!holder && !S.pending) {
            // No holder yet — this tap establishes who picked up the disc.
            // No event is logged; the next throw starts from this player.
            S.manualHolder = p;
            render();
            return;
        }
        if (holder && holder.name === name && !S.pending) {
            // Tapping the holder is a no-op (nothing to throw to themselves).
            return;
        }
        // Arm/disarm as the receiver (or dropper, if a drop is pending).
        S.armed = (S.armed && S.armed.name === name) ? null : p;
        render();
    }

    function handleFieldTap(loc, cx, cy) {
        if (S.pulling) { placePull(loc.l, loc.w, false); return; }
        if (S.dPlacing) {
            if (S.armed) { placeD(loc.l, loc.w); return; }
            // No defender picked yet — pick from a field-side popover, then place.
            popPicker(cx, cy, player => { S.armed = player; placeD(loc.l, loc.w); });
            return;
        }
        // Offense
        const state = reconstructState();
        if (state.mode !== 'offense') return;
        if (S.pending === 'throwaway') { placeThrowaway(loc); return; }
        if (S.armed) { placeOffense(S.armed, loc); return; }
        if (!effectiveHolder(state) && !S.pending) {
            // No holder yet — field-first tap picks who picked it up *and*
            // where, anchoring the next throw at that spot.
            popPicker(cx, cy, player => {
                S.manualHolder = player;
                S.pickupLoc = clampLoc(loc.l, loc.w);
                render();
            }, 'Who picked it up?');
            return;
        }
        // Nothing armed — field-first popover picks the receiver (or dropper).
        popPicker(cx, cy, player => { S.armed = player; placeOffense(player, loc); });
    }

    // ---- Offense placement ----

    /**
     * Commit an offense placement for `receiver` at `loc`: a drop if one is
     * pending, otherwise a completion — auto-promoted to a score when the
     * catch is in the attacking endzone (or Score is pending).
     */
    function placeOffense(receiver, loc) {
        if (!requireActiveCoach()) return;
        const state = reconstructState();
        const holder = effectiveHolder(state);
        const from = discLoc(state);
        const to = clampLoc(loc.l, loc.w);

        if (S.pending === 'drop') {
            // Drop: thrower = holder (Unknown if nobody established), the
            // armed/picked player is the one who dropped it. Flips to defense.
            const thrower = holder || (window.pbpPossession && window.pbpPossession.getUnknown());
            window.pbpPossession.createTurnover(thrower, receiver, { drop: true, from, to });
            clearEntryState();
            render();
            return;
        }

        if (!holder) {
            // No thrower known — credit the Unknown player so the completion
            // still lands (matches Full PBP's convention).
            const unknown = window.pbpPossession && window.pbpPossession.getUnknown();
            if (!unknown) return;
            commitThrow(unknown, receiver, from, to);
            return;
        }
        commitThrow(holder, receiver, from, to);
    }

    function commitThrow(thrower, receiver, from, to) {
        const isScore = S.pending === 'score' || inAttackEZ(to);
        window.pbpPossession.createThrow(thrower, receiver, {
            score: isScore,
            from, to,
            // Default assist = thrower; Phase 6's attribution dialog makes
            // this editable before/after confirm.
            assist: isScore ? thrower : null
        });
        clearEntryState();
        render();
    }

    function placeThrowaway(loc) {
        if (!requireActiveCoach()) return;
        const state = reconstructState();
        const holder = effectiveHolder(state);
        const thrower = holder || (window.pbpPossession && window.pbpPossession.getUnknown());
        if (!thrower) return;
        window.pbpPossession.createTurnover(thrower, null, {
            throwaway: true,
            from: discLoc(state),
            to: clampLoc(loc.l, loc.w)
        });
        clearEntryState();
        render();
    }

    function togglePending(action) {
        if (!requireActiveCoach()) return;
        S.pending = (S.pending === action) ? null : action;
        render();
    }

    // ---- Defense (D-possession) ----
    function setDPlacing(type) {
        if (!requireActiveCoach()) return;
        S.dPlacing = type;
        S.armed = null;
        S.dMods = [];
        render();
    }
    function cancelDPlacing() {
        S.dPlacing = null;
        S.armed = null;
        S.dMods = [];
        render();
    }
    function toggleDMod(label) {
        const k = S.dMods.indexOf(label);
        if (k >= 0) S.dMods.splice(k, 1); else S.dMods.push(label);
        render();
    }
    function placeD(l, w) {
        if (!requireActiveCoach()) return;
        if (!S.armed || !S.dPlacing) return;
        const opts = { to: clampLoc(l, w) };
        if (S.dPlacing === 'block') opts.block = true;
        else if (S.dPlacing === 'interception') opts.interception = true;
        else if (S.dPlacing === 'stall') opts.stall = true;
        else if (S.dPlacing === 'callahan') opts.Callahan = true;
        S.dMods.forEach(label => { const m = DMODS.find(dm => dm.label === label); if (m) opts[m.prop] = true; });
        // Block/Interception/Stall flip us to offense; Callahan is a defensive
        // goal (createDefense scores + advances the point). Interception → that
        // defender holds; Block leaves no holder (disc on the ground).
        window.pbpPossession.createDefense(S.armed, opts);
        S.dPlacing = null; S.armed = null; S.dMods = [];
        render();
    }
    function handleTheyTurnover() {
        if (!requireActiveCoach()) return;
        // Unforced opponent turnover (no specific defender) → flip to offense.
        window.pbpPossession.createDefense(null, { unforcedError: true });
        S.dPlacing = null; S.armed = null; S.dMods = [];
        render();
    }
    function handleTheyScore() {
        if (!requireActiveCoach()) return;
        // Delegate to the shared They-Score handler (point-timer / score /
        // moveToNextPoint plumbing), same as Simple/Full.
        if (typeof handlePbpTheyScore === 'function') handlePbpTheyScore();
        render();
    }
    function handleMore() {
        // D overflow (footblock / handblock / bid / …) lands in Phase 7.
        console.log('[fieldPbp] D "⋯ more" overflow (phase 7)');
    }

    // Field-side popover to pick a player when none is armed yet.
    function popPicker(cx, cy, cb, title) {
        document.querySelectorAll('.fp-picker').forEach(n => n.remove());
        const point = (typeof getLatestPoint === 'function') ? getLatestPoint() : null;
        const names = (point && point.players) ? point.players.slice() : [];
        const m = document.createElement('div');
        m.className = 'fp-picker';
        m.style.left = cx + 'px';
        m.style.top = cy + 'px';
        const ttl = title || (S.dPlacing === 'interception' ? 'Who intercepted?'
            : S.dPlacing ? `Who got the ${S.dPlacing}?`
            : S.pending === 'drop' ? 'Who dropped it?' : 'Who caught it?');
        let html = `<div class="fp-picker-ttl">${ttl}</div>`;
        names.forEach(name => {
            const p = playerByName(name); if (!p) return;
            const lead = (p.number != null) ? `<span class="fp-num">${p.number}</span>` : '';
            html += `<div class="fp-chip" data-pname="${name}">${lead}<span class="fp-nm">${name}</span></div>`;
        });
        html += `<div class="fp-chip unknown" data-pname="${UNKNOWN_PLAYER}"><span class="fp-umark">?</span><span class="fp-nm">Unknown</span></div>`;
        m.innerHTML = html;
        document.body.appendChild(m);
        m.querySelectorAll('.fp-chip[data-pname]').forEach(c => {
            c.onclick = ev => { ev.stopPropagation(); const name = c.dataset.pname; m.remove(); cb(playerByName(name)); };
        });
        setTimeout(() => {
            const close = ev => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('pointerdown', close); } };
            document.addEventListener('pointerdown', close);
        }, 0);
    }

    function handleUndo() {
        if (!requireActiveCoach()) return;
        // Bail out of an in-progress pull / D placement cleanly rather than
        // undoing a prior committed event.
        if (S.pulling && S.pullMs === null && !S.puller) {
            S.pulling = false;
            if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
            render();
            return;
        }
        if (S.dPlacing) { cancelDPlacing(); return; }
        if (S.armed || S.pending || S.manualHolder) {
            // In-progress offense entry (armed receiver / pending action /
            // pickup choice) — clear it rather than undoing a committed event.
            clearEntryState();
            render();
            return;
        }

        if (typeof undoEvent === 'function') undoEvent();
        S.pulling = false; S.puller = null; S.pullMs = null; S.pullMods = [];
        S.dPlacing = null; S.dMods = [];
        clearEntryState();
        if (pullTimer) { clearInterval(pullTimer); pullTimer = null; }
        render();
    }

    function handleStartPoint() {
        if (typeof handlePanelStartPoint === 'function') handlePanelStartPoint();
        else if (typeof startNextPoint === 'function') startNextPoint();
    }

    // -----------------------------------------------------------------
    // Unified pointer layer — distinguishes tap from drag so all three
    // placement gestures coexist: tap chip → tap spot, tap empty spot →
    // popover, drag chip (pegman) → drop on field. Recent markers drag to
    // fine-tune (re-anchoring the adjacent throw). Listeners for move/up sit
    // on window, so per-render DOM rebuilds don't break an active drag.
    // -----------------------------------------------------------------
    const DRAG_THRESHOLD_PX = 6;
    let drag = null;     // {kind:'chip'|'marker'|'field', ...}
    let pegEl = null;    // floating pegman element while dragging a chip

    function fieldEl() { return document.querySelector('#panel-playByPlayField-content #fpField'); }

    function pointInField(cx, cy) {
        const f = fieldEl();
        if (!f) return null;
        const r = f.getBoundingClientRect();
        const fx = (cx - r.left) / r.width, fy = (cy - r.top) / r.height;
        if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
        return toField(fx, fy);
    }

    function onPointerDown(e) {
        const chip = e.target.closest('.fp-chip[data-pname]');
        if (chip) { startDrag({ kind: 'chip', name: chip.dataset.pname }, e); return; }
        const mk = e.target.closest('.fp-marker[data-mkidx]');
        if (mk) { startDrag({ kind: 'marker', idx: +mk.dataset.mkidx }, e); return; }
        if (e.target.closest('#fpField')) { startDrag({ kind: 'field' }, e); return; }
    }

    function startDrag(d, e) {
        drag = Object.assign({ sx: e.clientX, sy: e.clientY, moved: false }, d);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
    }

    function onPointerMove(e) {
        if (!drag) return;
        if (!drag.moved) {
            if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < DRAG_THRESHOLD_PX) return;
            drag.moved = true;
        }
        if (drag.kind === 'chip') {
            if (!pegEl) {
                pegEl = document.createElement('div');
                pegEl.className = 'fp-pegman';
                pegEl.textContent = '🧍 ' + (drag.name === UNKNOWN_PLAYER ? 'Unknown' : drag.name);
                document.body.appendChild(pegEl);
            }
            pegEl.style.left = e.clientX + 'px';
            pegEl.style.top = (e.clientY - 6) + 'px';
        } else if (drag.kind === 'marker') {
            const loc = pointInField(e.clientX, e.clientY);
            if (loc) moveMarker(drag.idx, clampLoc(loc.l, loc.w));
        }
    }

    function onPointerUp(e) {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        if (pegEl) { pegEl.remove(); pegEl = null; }
        const d = drag; drag = null;
        if (!d) return;

        if (d.kind === 'chip') {
            if (!d.moved) { handleChipTap(d.name); return; }
            const loc = pointInField(e.clientX, e.clientY);
            if (!loc) { render(); return; }
            // Chip dropped on the field — one-gesture pick + place.
            handleChipDrop(d.name, loc);
        } else if (d.kind === 'marker') {
            if (d.moved) finishMarkerDrag(d.idx);
        } else if (d.kind === 'field') {
            if (!d.moved) {
                const loc = pointInField(e.clientX, e.clientY);
                if (loc) handleFieldTap(loc, e.clientX, e.clientY);
            }
        }
    }

    /** Chip dragged onto the field: same as arming the player then tapping. */
    function handleChipDrop(name, loc) {
        if (!requireActiveCoach()) return;
        const p = playerByName(name);
        if (!p) return;
        if (S.pulling) { S.puller = p; placePull(loc.l, loc.w, false); return; }
        if (S.dPlacing) { S.armed = p; placeD(loc.l, loc.w); return; }
        const state = reconstructState();
        if (state.mode !== 'offense') return;
        if (!effectiveHolder(state) && !S.pending) {
            // No holder — dragging a player to a spot records the pickup
            // (player + location), no event.
            S.manualHolder = p;
            S.pickupLoc = clampLoc(loc.l, loc.w);
            render();
            return;
        }
        placeOffense(p, loc);
    }

    // ---- Marker fine-tune ----

    /**
     * Live-update a located event's landing point while dragging its marker.
     * Keeps the throw chain intact: the next event's `from` was this catch,
     * so it moves too. Persisting + bus publish happen once, on release.
     */
    function moveMarker(idx, loc) {
        const state = reconstructState();
        const evs = pointEvents(state.point);
        const ev = evs[idx];
        if (!ev || !ev.to) return;
        ev.to = loc;
        if (evs[idx + 1] && evs[idx + 1].from) evs[idx + 1].from = loc;
        render();
    }

    function finishMarkerDrag(idx) {
        const state = reconstructState();
        const evs = pointEvents(state.point);
        const ev = evs[idx];
        if (!ev) return;
        if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
        if (window.narrationEventBus) {
            window.narrationEventBus.publish('eventAmended', {
                event: ev, previousEvent: null, source: 'manual', provisionalId: null
            });
        }
        render();
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

        // Chips, markers, and the field all route through the unified pointer
        // layer (tap vs drag) — a single pointerdown hook on the panel root.
        root.onpointerdown = onPointerDown;

        // Pull hang/brick buttons
        root.querySelectorAll('.fp-ebtn[data-pull]').forEach(b => {
            b.onclick = () => { b.dataset.pull === 'hang' ? toggleHang() : placePull(0, 0, true); };
        });

        // Pull modifier tags
        root.querySelectorAll('.fp-modbtn[data-pmod]').forEach(b => {
            b.onclick = () => togglePullMod(b.dataset.pmod);
        });

        // Defense: D-action buttons, cancel, bottom-bar actions, D modifiers
        root.querySelectorAll('.fp-dtypebtn[data-dtype]').forEach(b => {
            b.onclick = () => setDPlacing(b.dataset.dtype);
        });
        const dcancel = root.querySelector('.fp-dcancel[data-dcancel]');
        if (dcancel) dcancel.onclick = cancelDPlacing;
        root.querySelectorAll('.fp-ebtn[data-act]').forEach(b => {
            b.onclick = () => {
                const act = b.dataset.act;
                if (act === 'theyturn') handleTheyTurnover();
                else if (act === 'theyscore') handleTheyScore();
                else if (act === 'more') handleMore();
                else if (act === 'drop' || act === 'throwaway' || act === 'score') togglePending(act);
            };
        });
        root.querySelectorAll('.fp-modbtn[data-dmod]').forEach(b => {
            b.onclick = () => toggleDMod(b.dataset.dmod);
        });

        // (Field taps are handled by the pointer layer above — no onclick.)
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
