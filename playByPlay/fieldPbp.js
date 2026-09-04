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
 * Drawing — geometry, the normalized stored-coordinate frame, the static
 * pitch layers, event arrows/markers/disc, the possession fade cohorts and
 * player chips — lives in the shared renderer playByPlay/fieldRender.js, whose
 * file header is the canonical description of the coordinate system. This
 * file owns only the interactive surface: entry state, gestures, the pull
 * stopwatch, pickers, orientation and the flip settings, which it hands to
 * the renderer as a `view` object.
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
import { UNKNOWN_PLAYER } from '../store/models.js';
import { saveAllTeamsData, currentTeam } from '../store/storage.js';
import {
    setLabelsForSide, setControlLabel, taggablePossession,
} from '../utils/possessionSets.js';
import {
    currentGame, getLatestPoint, getPlayerFromName, isPointInProgress,
    determineStartingPosition, showPlayerNumbers,
    buildPointPlayerLookup, playerStub,
} from '../utils/helpers.js';
import { undoEvent } from '../game/gameLogic.js';
import { startNextPoint } from '../game/pointManagement.js';
import { showControllerToast } from '../game/controllerState.js';
import { ensureDialogVisible, handlePbpTheyScore, handlePbpGameEvents } from '../game/gameScreenEvents.js';
import { handlePanelStartPoint } from '../game/selectLine.js';
import { wireSetControl } from '../ui/setPicker.js';
import { ensurePossessionExists } from './keyPlayDialog.js';
import { showScoreAttributionDialog } from './scoreAttribution.js';
import { classifyThrowGeometry, reclassifyThrow as reclassifyThrowGeometry } from './eventAmend.js';
import {
    geom, W, refreshGeometry, toNorm, clampLoc, inAttackEZ,
    pct as renderPct, toField as renderToField,
    fieldHTML as renderFieldHTML, createFadeTracker, chipHTML,
    stablePointKey as renderPointKey,
} from './fieldRender.js';

const fieldPbp = (function() {

    // -----------------------------------------------------------------
    // Display flips (orientation): which sideline is Home (flipHA) and which
    // way we attack (flipAD). Both are render-time only — canonical {l,w}
    // never change. flipHA is a stable per-device setting; flipAD is a base
    // that auto-alternates each point (teams switch ends every point), derived
    // via point parity in effFlipAD() so no per-point bookkeeping is needed.
    // -----------------------------------------------------------------
    function loadFlips() {
        if (window.advancedSettings && typeof window.advancedSettings.get === 'function') {
            S.flipHA = !!window.advancedSettings.get('field.flipHA');
            S.flipAD = !!window.advancedSettings.get('field.flipAD');
        }
    }
    function persistFlips() {
        if (window.advancedSettings && typeof window.advancedSettings.set === 'function') {
            window.advancedSettings.set('field.flipHA', S.flipHA);
            window.advancedSettings.set('field.flipAD', S.flipAD);
        }
    }
    function currentPointIndex() {
        const g = (typeof currentGame === 'function') ? currentGame() : null;
        return (g && g.points && g.points.length) ? g.points.length - 1 : 0;
    }
    // Effective attack flip = base XOR point parity, so the attack direction
    // auto-alternates each point on top of the coach's chosen base.
    function effFlipAD() {
        return S.flipAD !== (currentPointIndex() % 2 === 1);
    }

    // The renderer's view object: orientation + the EFFECTIVE flips (see the
    // playByPlay/fieldRender.js header for the shape). Built per call so it
    // always reflects the current point parity.
    function view() {
        return { o: S.o, flipAD: effFlipAD(), flipHA: S.flipHA };
    }
    function toggleFlip(which) {
        if (which === 'ad') S.flipAD = !S.flipAD;
        else S.flipHA = !S.flipHA;
        persistFlips();
        render();
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

    // Possession-change fade state (see fieldRender.js § createFadeTracker):
    // one tracker per field on screen; its cleanup callback is a re-render
    // that drops finished cohorts.
    const fade = createFadeTracker(() => render());

    const PMODS = [
        { label: 'Roller', prop: 'roller' },
        { label: 'OI', prop: 'oi' },
        { label: 'IO', prop: 'io' }
    ];
    const DMODS = [
        { label: 'Layout', prop: 'layout' },
        { label: 'Sky', prop: 'sky' }
    ];
    // Interactive chips that tag the *last recorded* event, keyed by event type.
    // Each toggles a boolean *_flag directly on the event (then amend + persist).
    const LASTMODS = {
        Throw: [
            { label: 'Break', flag: 'break_flag' },
            { label: 'Huck', flag: 'huck_flag' },
            { label: 'Reset', flag: 'reset_flag' },
            { label: 'Swing', flag: 'swing_flag' },
            { label: 'Hammer', flag: 'hammer_flag' },
            { label: 'Sky', flag: 'sky_flag' },
            { label: 'Layout', flag: 'layout_flag' }
        ],
        Defense: [
            { label: 'Layout', flag: 'layout_flag' },
            { label: 'Sky', flag: 'sky_flag' }
        ],
        Turnover: [
            { label: 'Huck', flag: 'huck_flag' }
        ]
    };
    // D actions shown in the player slot until one is chosen.
    const DTYPES = [
        { type: 'block', label: 'Block' },
        { type: 'interception', label: 'Interception' },
        { type: 'stall', label: 'Stall' },
        { type: 'callahan', label: 'Callahan' }
    ];
    const cap = s => s ? s[0].toUpperCase() + s.slice(1) : '';

    // -----------------------------------------------------------------
    // -----------------------------------------------------------------
    // Coordinate mapping — the renderer's pct()/toField() bound to this
    // tab's current view (orientation + effective flips).
    // -----------------------------------------------------------------
    function pct(l, w) { return renderPct(view(), l, w); }
    function toField(fx, fy) { return renderToField(view(), fx, fy); }

    // -----------------------------------------------------------------
    // State derivation (shared possession core).
    // -----------------------------------------------------------------
    // Identity-stable key for a point (see fieldRender.js § stablePointKey):
    // keyed on game id + point index, not object identity, because cloud
    // sync replaces the Point objects. Null when there's no game/point yet.
    function stablePointKey(point) {
        const game = (typeof currentGame === 'function') ? currentGame() : null;
        return renderPointKey(game, point);
    }

    // Tracks the point last seen by reconstructState so we can detect
    // crossing a point boundary and drop stale pickup state. Mirrors the
    // guard in fullPbp.js: without it, a manual holder / pickup spot tapped
    // in a prior point can survive into a new point when the point ends via
    // a path that doesn't run Field's own handlers (Simple-mode "They
    // Score", narration), so the next point would start with a phantom
    // holder/disc. Keyed by stablePointKey, NOT object identity — a sync
    // refresh mid-point must not wipe the coach's pickup selection.
    let _lastSeenPointKey = null;
    function reconstructState() {
        const point = (typeof getLatestPoint === 'function') ? getLatestPoint() : null;
        const key = stablePointKey(point);
        if (key !== _lastSeenPointKey) {
            S.manualHolder = null;
            S.pickupLoc = null;
            _lastSeenPointKey = key;
        }
        if (window.pbpPossession && typeof window.pbpPossession.reconstructState === 'function') {
            return window.pbpPossession.reconstructState();
        }
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
    // -----------------------------------------------------------------
    // Field rendering: static geometry + located-event arrows/markers/disc,
    // drawn by the shared renderer. The disc override is this tab's pickup
    // spot; the fade tracker is this tab's own instance.
    // -----------------------------------------------------------------
    function fieldHTML(state) {
        return renderFieldHTML(view(), {
            events: pointEvents(state.point),
            mode: state.mode,
            pointKey: stablePointKey(state.point),
            discLoc: S.pickupLoc,
            fade,
        });
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
        // point.players entries may be current names, player ids (id-era
        // games), or stale names — resolve through the game-scoped lookup so
        // no chip silently vanishes from the rail.
        const lookup = buildPointPlayerLookup(currentGame());
        let html = lead + point.players.map(entry => {
            const { name, obj } = lookup(entry);
            const isHolder = !!(holder && holder.name === name);
            const isArmed = !!(armedName && armedName === name);
            return chipHTML(obj, { holder: isHolder, armed: isArmed });
        }).join('');
        const unknown = (typeof getPlayerFromName === 'function') ? getPlayerFromName(UNKNOWN_PLAYER) : null;
        if (unknown) html += chipHTML(unknown, { unknown: true, armed: armedName === UNKNOWN_PLAYER });
        return html;
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
                + `<button class="fp-ebtn theyscore" data-act="theyscore">They score</button>`;
        }
        if (inPoint && state.mode === 'offense') {
            const on = a => S.pending === a ? ' on' : '';
            return `<button class="fp-ebtn drop${on('drop')}" data-act="drop">Drop</button>`
                + `<button class="fp-ebtn throwaway${on('throwaway')}" data-act="throwaway">Throwaway</button>`
                + `<button class="fp-ebtn score${on('score')}" data-act="score">Score</button>`;
        }
        return '';
    }

    /**
     * Set tagging for the live possession — a button in the action row, just
     * left of Events, where it's reachable as the possession unfolds. Tap
     * cycles, long-press opens the full list (ui/setPicker.js, shared with the
     * Full tab so the two surfaces can't drift).
     *
     * Renders only mid-point, and only for teams opted into set tracking that
     * configured labels for the side currently in possession. Hiding it
     * between points is deliberate: that's when the action row is tightest
     * (the O/D pill becomes "Start Point (Offense)"), and there is no live
     * possession to tag anyway.
     *
     * Defensive sets used to be picked in the pull dialog; that was removed
     * 2026-08-09 (overflowed on a phone, and the set usually isn't known until
     * the D is actually running).
     */
    function liveSetTarget(state) {
        // Keyed off the LIVE mode, not the last possession — the two diverge at
        // a change of possession, and the stale possession's side would offer
        // the wrong list (see utils/possessionSets.js § setLabelsForSide).
        const wantOffensive = state.mode !== 'defense';
        const last = taggablePossession(state.point);
        const matchesSide = !!last && ((last.offensive !== false) === wantOffensive);
        return {
            wantOffensive,
            labels: setLabelsForSide(currentTeam, wantOffensive),
            possession: matchesSide ? last : null,
        };
    }

    function setControlHTML(state, inPoint) {
        if (!inPoint || !state.point) return '';
        const { labels, possession } = liveSetTarget(state);
        if (!labels.length) return '';
        const caption = setControlLabel(possession)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<button class="fp-setbtn${possession && possession.set ? ' on' : ''}" data-setcycle="1" `
            + `title="Tap to cycle sets, long-press for the full list">${caption}</button>`;
    }

    function modColHTML(state, inPoint) {
        return modColBodyHTML(state);
    }

    function modColBodyHTML(state) {
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
        // Tag the last recorded event: name it, then offer interactive chips
        // (Break/Huck/Reset/… for a throw, Layout/Sky for a D) that toggle the
        // event's flags directly. The header adapts to the event type. Because
        // findLastEditableEvent returns the last Throw/Turnover/Defense, a D
        // stays taggable on the O screen until the first completed pass.
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
        const chips = (le ? (LASTMODS[le.type] || []) : []).map(m =>
            `<button class="fp-modbtn ${le[m.flag] ? 'on' : ''}" data-lastmod="${m.flag}">${m.label}</button>`
        ).join('');
        const chipsBlock = chips ? `<div class="fp-modchips">${chips}</div>` : '';
        return `<div class="fp-modcol-label">${label}</div><div class="fp-modcol-sub">${sub}</div>${chipsBlock}`;
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
        if (holder && S.manualHolder && !S.pickupLoc) {
            // Holder chosen but not yet placed — prompt for the pickup spot.
            return `<b>${holder.name === UNKNOWN_PLAYER ? 'Unknown' : holder.name}</b> has the disc — tap where they picked it up`;
        }
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

        // Preserve the sidebar's scroll across the innerHTML rebuild — otherwise
        // every render (incl. the hangtime tick) snaps it back to the top,
        // hiding the modifier column at the bottom and fighting the user.
        const prevSidebar = content.querySelector('.fp-sidebar');
        const savedScroll = prevSidebar ? prevSidebar.scrollTop : null;

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
        // a PULL pill while pulling, else the mode pill. The Start Point label
        // names the upcoming point's side (Offense/Defense), matching the Line
        // tab's button.
        let leftSlot;
        if (S.pulling) {
            leftSlot = `<span class="fp-modepill pull">PULL</span>`;
        } else if (!inPoint) {
            const nextPos = (typeof determineStartingPosition === 'function') ? determineStartingPosition() : 'offense';
            const spLabel = `Start Point (${nextPos === 'defense' ? 'Defense' : 'Offense'})`;
            leftSlot = `<button class="fp-start-point-btn" id="fpStartPointBtn">${spLabel}</button>`;
        } else {
            leftSlot = `<span class="fp-modepill ${mode}">${modeLabel(mode)}</span>`;
        }

        content.dataset.o = S.o;
        content.dataset.mode = S.pulling ? 'pull' : mode;
        applyTakeoverClass();

        content.innerHTML = `
            <div class="fp-actionrow">
                ${leftSlot}
                <span class="fp-actionrow-spacer"></span>
                <span class="fp-status-inline">${statusText(state, inPoint)}</span>
                ${setControlHTML(state, inPoint)}
                <button class="fp-gameevents" id="fpGameEventsBtn" title="Timeout, injury sub, halftime, switch sides, end game"><i class="fas fa-cog"></i><span>Events</span></button>
                <button class="fp-undo" id="fpUndoBtn" title="Undo last event"><i class="fas fa-undo"></i><span>Undo</span></button>
            </div>
            <div class="fp-play${inPoint ? '' : ' fp-between-points'}">
                <div class="fp-prow">
                    <div class="fp-sidebar">
                        <div class="fp-rail">${playerRailHTML(state, inPoint)}</div>
                        <div class="fp-modsep"></div>
                        <div class="fp-modcol">${modColHTML(state, inPoint)}</div>
                    </div>
                    ${fieldBox}
                </div>
                <div class="fp-statusbar">${statusText(state, inPoint)}</div>
                <div class="fp-events">${eventsHTML(state, inPoint)}</div>
                <button class="fp-mic" title="Narration mic">&#127908;</button>
            </div>
        `;

        wireDynamic();

        // Restore sidebar scroll. On first entry to the pull flow, jump to the
        // bottom once so the pull modifiers are immediately reachable even when
        // the rail overflows (the coach can scroll back up to pick a different
        // puller); thereafter, honor wherever the user left it.
        const newSidebar = content.querySelector('.fp-sidebar');
        if (newSidebar) {
            if (S.pullScrollToTop) {
                newSidebar.scrollTop = 0;
                S.pullScrollToTop = false;
            } else if (S.pullScrollToBottom) {
                newSidebar.scrollTop = newSidebar.scrollHeight;
                S.pullScrollToBottom = false;
            } else if (savedScroll != null) {
                newSidebar.scrollTop = savedScroll;
            }
        }

        // Landscape: the rail never scrolls. After layout, measure natural
        // chip widths vs available width and progressively shrink — first by
        // dropping jersey numbers, then by collapsing the Unknown chip's
        // label to just "?". Run synchronously (after the innerHTML rebuild
        // layout is already committed); rAF would defer past the next paint,
        // which can flash full-size chips.
        if (S.o === 'landscape') fitPlayers();
    }

    /**
     * Landscape-only: make every player chip fit on one row without horizontal
     * scrolling. Two shrink stages, applied via classes on `.fp-rail`:
     *   1. `.fp-rail-tight`  — hide jersey numbers (.fp-num)
     *   2. `.fp-rail-xtight` — collapse the Unknown chip's label to "?"
     * Stages are additive: tight may be enough; if not, xtight piles on.
     * Measurement temporarily sets each chip to `flex: 0 0 auto` to read its
     * natural width — synchronous within the rAF, so no paint flash.
     */
    function fitPlayers() {
        const content = document.getElementById('panel-playByPlayField-content');
        if (!content || content.dataset.o !== 'landscape') return;
        const rail = content.querySelector('.fp-rail');
        if (!rail) return;
        const chips = Array.from(rail.querySelectorAll('.fp-chip'));
        if (!chips.length) return;

        rail.classList.remove('fp-rail-tight', 'fp-rail-xtight');

        const railWidth = rail.clientWidth;
        if (railWidth <= 0) return;

        function measureNatural() {
            chips.forEach(c => { c.style.flex = '0 0 auto'; });
            // Force a reflow so offsetWidth reflects the override.
            const w = chips.reduce((s, c) => s + c.offsetWidth, 0);
            chips.forEach(c => { c.style.flex = ''; });
            const gap = 6 * Math.max(0, chips.length - 1);
            return w + gap;
        }

        if (measureNatural() <= railWidth) return;

        rail.classList.add('fp-rail-tight');
        if (measureNatural() <= railWidth) return;

        rail.classList.add('fp-rail-xtight');
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
        S.pullScrollToTop = true;   // start at the top so "Pick Puller" + all
                                    // players are visible; we drop to the
                                    // modifiers once a puller is tapped.
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
        // We pull from our defending goal line (normalized x=0, mid-width). On a
        // brick the receiving (opponent) offense takes it to the brick mark in
        // front of the endzone they're attacking — i.e. the FAR brick mark, near
        // our attacking end (BRICK[1] = L - EZ - BRICK_OFFSET), not the near one
        // by our defending end. Stored normalized so it's independent of the
        // per-point attack direction (effFlipAD is render-only) and of EZ depth.
        const from = toNorm({ l: geom.EZ, w: W / 2 });
        const to = brick ? toNorm({ l: geom.BRICK[1], w: W / 2 }) : toNorm(clampLoc(l, w));

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
        // Fall back to a minimal stub so a chip whose player no longer
        // resolves on the current roster still records events by name.
        const player = (typeof getPlayerFromName === 'function') ? getPlayerFromName(name) : null;
        return player || playerStub(name);
    }

    function handleChipTap(name) {
        if (!requireActiveCoach()) return;
        const p = playerByName(name);
        if (S.pulling) {
            const selecting = !(S.puller && S.puller.name === name);
            S.puller = selecting ? p : null;
            // On selecting a puller, drop to the bottom so the pull modifiers
            // and hang/Brick are in reach; deselecting leaves scroll as-is.
            if (selecting) S.pullScrollToBottom = true;
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
        if (holder && holder.name === name && holder.name !== UNKNOWN_PLAYER) {
            // Tapping the holder is a no-op — they can't receive (or drop)
            // their own throw. Unknown is exempt: unknown → unknown throws
            // are legal (same convention as the score dialog).
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
        // Pickup placement: a holder was chosen (tapped a chip) at the start of
        // the possession but hasn't been placed yet. This field tap marks WHERE
        // they picked it up — it anchors the first throw, it is NOT a throw, so
        // don't open the receiver popover.
        if (S.manualHolder && !S.pickupLoc && !S.pending) {
            S.pickupLoc = toNorm(clampLoc(loc.l, loc.w));
            render();
            return;
        }
        if (!effectiveHolder(state) && !S.pending) {
            // No holder yet — field-first tap picks who picked it up *and*
            // where, anchoring the next throw at that spot.
            popPicker(cx, cy, player => {
                S.manualHolder = player;
                S.pickupLoc = toNorm(clampLoc(loc.l, loc.w));
                render();
            }, 'Who picked it up?');
            return;
        }
        // Nothing armed — field-first popover picks the receiver (or dropper).
        // The holder is excluded: they can't catch (or drop) their own throw.
        const holder = effectiveHolder(state);
        const excludeSelf = (holder && holder.name !== UNKNOWN_PLAYER) ? holder.name : null;
        popPicker(cx, cy, player => { S.armed = player; placeOffense(player, loc); }, null, excludeSelf);
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

        // Self-pass guard (defense in depth behind the inert holder chip and
        // the popover exclusion): the holder can't be their own receiver or
        // dropper. Unknown → Unknown stays legal.
        if (holder && receiver && holder.name === receiver.name
            && holder.name !== UNKNOWN_PLAYER) {
            if (typeof showControllerToast === 'function') {
                showControllerToast(`${holder.name} already has the disc`, 'warning', 2000);
            }
            S.armed = null;
            render();
            return;
        }
        // `from` is the disc's current spot (already a stored, normalized coord);
        // `to` is the tap, converted from yards to the normalized stored frame.
        const from = discLoc(state);
        const to = toNorm(clampLoc(loc.l, loc.w));

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

    /**
     * Auto-classification of a throw from its geometry (stored normalized
     * coords: x = progress toward the attacking endzone as a fraction of the
     * playing field, y = across the width). Returns modifier flags that are
     * pre-set on the committed Throw — the coach can always override them via
     * the "Last throw was a:" chips (or the score dialog's flag buttons):
     *   - huck:  forward progress ≥ the settable fraction (Advanced Settings
     *            → Field → Huck threshold, default 50% of the playing field)
     *   - reset (reset_flag): meaningfully backwards (beyond a small tolerance
     *            so flat lateral passes don't count)
     *   - swing: lateral travel ≥ the settable fraction of the field width
     *            (Advanced Settings → Field → Swing threshold, default 25%),
     *            unless it's a huck (a deep cross-field shot reads as a huck,
     *            not a swing)
     */
    function settingFraction(key, dflt) {
        if (window.advancedSettings && typeof window.advancedSettings.get === 'function') {
            const v = parseFloat(window.advancedSettings.get(key));
            if (Number.isFinite(v) && v > 0) return v;
        }
        return dflt;
    }
    function geometryFractions() {
        return {
            huckFraction: settingFraction('field.huckFraction', 0.5),
            swingFraction: settingFraction('field.swingFraction', 0.25),
        };
    }
    /**
     * Huck / reset / swing from the endpoints — the rule is shared with the
     * replay editor (playByPlay/eventAmend.js). Key names feed createThrow's
     * opts verbatim via commitThrow's spread — they must match the
     * constructor params (reset, not the old dump).
     */
    function classifyThrow(from, to) {
        return classifyThrowGeometry(from, to, geometryFractions());
    }

    function commitThrow(thrower, receiver, from, to) {
        const isScore = S.pending === 'score' || inAttackEZ(to);
        clearEntryState();
        if (isScore) {
            // Don't commit yet — open the shared Score Attribution dialog (the
            // same one Simple/Full PBP use), pre-selecting thrower/receiver and
            // carrying the tap locations through opts.from/opts.to so the
            // spatial marker survives. The dialog's Score button commits a goal,
            // "continue possession" downgrades to a plain completion, and its
            // modifier flags (huck/break/sky/layout/hammer) apply either way.
            // A geometry-detected huck pre-checks the dialog's Huck flag.
            openScoreDialog(thrower, receiver, from, to);
            render();
            return;
        }
        window.pbpPossession.createThrow(thrower, receiver,
            { score: false, from, to, ...classifyThrow(from, to) });
        render();
    }

    /**
     * Open the shared Score Attribution dialog with the Field-tab tap
     * locations pre-loaded. Stops the point timer first (matching Full PBP /
     * Simple mode) so the displayed duration doesn't tick while the coach
     * fiddles with modifier flags. Falls back to a direct scoring throw if the
     * shared dialog isn't loaded.
     */
    function openScoreDialog(thrower, receiver, from, to) {
        const point = (typeof getLatestPoint === 'function') ? getLatestPoint() : null;
        if (point && point.startTimestamp) {
            point.totalPointTime = (point.totalPointTime || 0)
                + (Date.now() - new Date(point.startTimestamp).getTime());
            point.startTimestamp = null;
        }

        if (typeof ensureDialogVisible === 'function') ensureDialogVisible('scoreAttributionDialog');

        if (typeof showScoreAttributionDialog === 'function') {
            showScoreAttributionDialog({
                thrower, receiver, from, to,
                huckArmed: !!classifyThrow(from, to).huck,
            });
        } else {
            console.warn('[fieldPbp] showScoreAttributionDialog unavailable; falling back to direct createThrow');
            window.pbpPossession.createThrow(thrower, receiver,
                { score: true, from, to, ...classifyThrow(from, to) });
        }
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
            to: toNorm(clampLoc(loc.l, loc.w))
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

    /**
     * Toggle a modifier flag on the last recorded event (the modifier column's
     * interactive chips). Mutates the flag in place, then persists + publishes
     * an amend so every PBP tab repaints — the same amend path the marker drag
     * uses.
     */
    function toggleLastMod(flag) {
        if (!requireActiveCoach()) return;
        const state = reconstructState();
        const le = (window.pbpPossession && state.point)
            ? window.pbpPossession.findLastEditableEvent(state.point) : null;
        if (!le) return;
        le[flag] = !le[flag];
        if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
        if (window.narrationEventBus) {
            window.narrationEventBus.publish('eventAmended', {
                event: le, previousEvent: null, source: 'manual', provisionalId: null
            });
        }
        render();
    }
    function placeD(l, w) {
        if (!requireActiveCoach()) return;
        if (!S.armed || !S.dPlacing) return;
        const opts = { to: toNorm(clampLoc(l, w)) };
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
    // Field-side popover to pick a player when none is armed yet.
    // `excludeName` omits one roster player — used to keep the disc-holder
    // out of receiver/dropper picks (no self-passes). Unknown always shows.
    function popPicker(cx, cy, cb, title, excludeName) {
        document.querySelectorAll('.fp-picker').forEach(n => n.remove());
        const point = (typeof getLatestPoint === 'function') ? getLatestPoint() : null;
        const names = (point && point.players) ? point.players.slice() : [];
        const m = document.createElement('div');
        m.className = 'fp-picker';
        const ttl = title || (S.dPlacing === 'interception' ? 'Who intercepted?'
            : S.dPlacing ? `Who got the ${S.dPlacing}?`
            : S.pending === 'drop' ? 'Who dropped it?' : 'Who caught it?');
        let html = `<div class="fp-picker-ttl">${ttl}</div>`;
        // Entries may be ids or stale names — resolve to the canonical
        // current name (also what excludeName, a live player's .name, expects).
        const lookup = buildPointPlayerLookup(currentGame());
        names.forEach(entry => {
            const { name, obj } = lookup(entry);
            if (excludeName && name === excludeName) return;
            const lead = (obj.number != null && showPlayerNumbers()) ? `<span class="fp-num">${obj.number}</span>` : '';
            html += `<div class="fp-chip" data-pname="${name}">${lead}<span class="fp-nm">${name}</span></div>`;
        });
        html += `<div class="fp-chip unknown" data-pname="${UNKNOWN_PLAYER}"><span class="fp-umark">?</span><span class="fp-nm">Unknown</span></div>`;
        m.innerHTML = html;
        // Position after measuring so the popover always stays fully on-screen
        // (it can hold the whole roster + Unknown, and a tap near the top —
        // e.g. a goal in the attacking endzone — used to push players off the
        // top with no way to reach them). Prefer above the tap; flip below if
        // there isn't room; clamp to the viewport; scroll if still too tall.
        m.style.left = '0px';
        m.style.top = '0px';
        m.style.visibility = 'hidden';
        document.body.appendChild(m);
        const margin = 8;
        const pw = m.offsetWidth, ph = m.offsetHeight;
        let left = cx - pw / 2;
        left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));
        let top = cy - ph - 12;                 // preferred: above the tap point
        if (top < margin) top = cy + 18;        // not enough room above → below
        top = Math.max(margin, Math.min(top, window.innerHeight - ph - margin));
        m.style.left = left + 'px';
        m.style.top = top + 'px';
        m.style.visibility = 'visible';

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
    // While dragging a player chip, the pegman's target ("X") floats this many
    // screen px above the finger so the fingertip never occludes the precise
    // drop spot (Google-Maps-Street-View style). The disc is recorded at the
    // lifted X, not under the finger — see onPointerMove / onPointerUp.
    const DRAG_LIFT_PX = 56;
    const LONGPRESS_MS = 500;
    let drag = null;     // {kind:'chip'|'marker'|'field', ...}
    let pegEl = null;    // floating pegman element while dragging a chip
    let labelPressTimer = null;

    /**
     * Long-press detector for a field label. Fires toggleFlip after LONGPRESS_MS
     * of a stationary hold; cancels on movement beyond the drag threshold or on
     * release. A short tap does nothing (so labels don't place events).
     */
    function startLabelPress(flip, e) {
        const sx = e.clientX, sy = e.clientY;
        let done = false;
        const cleanup = () => {
            if (labelPressTimer) { clearTimeout(labelPressTimer); labelPressTimer = null; }
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
        const onMove = ev => {
            if (!done && Math.hypot(ev.clientX - sx, ev.clientY - sy) > DRAG_THRESHOLD_PX) { done = true; cleanup(); }
        };
        const onUp = () => { if (!done) { done = true; cleanup(); } };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
        labelPressTimer = setTimeout(() => {
            if (done) return;
            done = true; cleanup();
            toggleFlip(flip === 'ad' ? 'ad' : 'ha');
        }, LONGPRESS_MS);
    }

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
        // Long-press a field label to flip orientation (Home/Away → flipHA,
        // Attack/Defend → flipAD). Allowed any time, even between points, since
        // it's a view setting — so this is checked before the read-only guard.
        const flbl = e.target.closest('.fp-flbl');
        if (flbl) { startLabelPress(flbl.dataset.flip, e); return; }

        // Between points the field is read-only — no events may be entered
        // until Start Point. (The pull flow runs after the point has started,
        // so isPointInProgress() is already true there.)
        const inPoint = (typeof isPointInProgress === 'function') && isPointInProgress();
        if (!inPoint && !S.pulling) return;
        const chip = e.target.closest('.fp-chip[data-pname]');
        if (chip) {
            // During the pull flow chips aren't draggable (the puller is placed
            // by tapping the field, not by dragging a pegman). Bail out of the
            // pointer layer so the rail scrolls natively; the tap itself is
            // handled by the chip's click handler wired in wireDynamic.
            if (S.pulling) return;
            // On offense the disc-holder's chip is inert — no drag (a player
            // can't pass to themselves) and the tap is a no-op anyway.
            // Unknown is exempt (unknown → unknown throws are legal).
            if (!S.dPlacing) {
                const st = reconstructState();
                const holder = effectiveHolder(st);
                if (st.mode === 'offense' && holder
                    && holder.name === chip.dataset.pname
                    && holder.name !== UNKNOWN_PLAYER) return;
            }
            startDrag({ kind: 'chip', name: chip.dataset.pname }, e);
            return;
        }
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
                // Street-View-style pegman: a name pill + figure standing on a
                // ground shadow, with an "X" marking the exact drop point. The
                // container is anchored at the drop point (the X); children sit
                // above it. Positioned in onPointerMove at (finger - lift).
                pegEl = document.createElement('div');
                pegEl.className = 'fp-pegman';
                pegEl.innerHTML =
                    '<div class="fp-peg-name"></div>' +
                    '<div class="fp-peg-figure">' +
                        '<img src="images/player.reach.png" alt="" draggable="false">' +
                    '</div>' +
                    '<div class="fp-peg-shadow"></div>' +
                    '<div class="fp-peg-x">✕</div>';
                pegEl.querySelector('.fp-peg-name').textContent =
                    drag.name === UNKNOWN_PLAYER ? 'Unknown' : drag.name;
                document.body.appendChild(pegEl);
            }
            pegEl.style.left = e.clientX + 'px';
            pegEl.style.top = (e.clientY - DRAG_LIFT_PX) + 'px';
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
            // Record at the lifted X (the pegman's drop point), not under the
            // finger — keeps the recorded spot where the coach actually aimed.
            const loc = pointInField(e.clientX, e.clientY - DRAG_LIFT_PX);
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
            S.pickupLoc = toNorm(clampLoc(loc.l, loc.w));
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
        // `loc` is a yards {l,w} tap; store the normalized form. toNorm() returns
        // a FRESH object per call, so ev.to and the chained next.from never alias
        // the same object — a later drag of one no longer silently moves the other.
        ev.to = toNorm(loc);
        if (evs[idx + 1] && evs[idx + 1].from) evs[idx + 1].from = toNorm(loc);
        render();
    }

    /**
     * Re-derive the geometry-based modifier flags (huck / reset / swing) for
     * a Throw whose endpoints changed (marker drag) — playByPlay/eventAmend.js
     * holds the rule; other flags (break, hammer, sky, layout) are untouched.
     */
    function reclassifyThrow(ev) {
        reclassifyThrowGeometry(ev, geometryFractions());
    }

    function finishMarkerDrag(idx) {
        const state = reconstructState();
        const evs = pointEvents(state.point);
        const ev = evs[idx];
        if (!ev) return;
        // Geometry changed — refresh the auto-classified flags for the
        // dragged throw AND the next event (its `from` moved with this catch).
        reclassifyThrow(ev);
        reclassifyThrow(evs[idx + 1]);
        if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
        if (window.narrationEventBus) {
            window.narrationEventBus.publish('eventAmended', {
                event: ev, previousEvent: null, source: 'manual', provisionalId: null
            });
        }
        render();
    }

    // -----------------------------------------------------------------
    // Orientation + landscape takeover
    // -----------------------------------------------------------------
    //
    // The browser/PWA Fullscreen API is unusable here: iOS Safari only honors
    // requestFullscreen() on <video>, and in standalone-PWA mode it's a no-op
    // on every element — and iOS PWA is a primary runtime (see ARCHITECTURE.md
    // § Target Platform). So instead of true fullscreen, landscape mode is a
    // CSS overlay: the panel is pinned `position: fixed; inset: 0` over the
    // app chrome (orange/purple header + tabbar), respecting safe-area insets.
    // Toggling is pure state — apply a `fp-landscape-takeover` class on <body>
    // and let CSS do the rest. Works identically across all phone browsers.

    /** Reflect S.o onto <body> so the overlay CSS can pin the panel. */
    function applyTakeoverClass() {
        document.body.classList.toggle('fp-landscape-takeover', S.o === 'landscape');
    }

    // Orientation is driven entirely by physical device rotation — there's no
    // manual portrait/landscape button. The Fullscreen and Screen Orientation
    // Lock APIs can't force rotation on iOS Safari / standalone PWA (lock()
    // is unsupported, and even on Android it requires fullscreen, which iOS
    // also lacks). So instead we hint the user that rotating the phone gives
    // the wide field view (once/day, suppressible — see ui/hints.js).

    /** Hint that rotating gives a full-screen view, when entering Field in portrait. */
    function maybeShowRotateHint() {
        if (S.o === 'landscape') return;                  // already wide — nothing to suggest
        if (window.matchMedia('(orientation: landscape)').matches) return;
        if (window.hints && typeof window.hints.maybeShow === 'function') {
            window.hints.maybeShow('field-rotate', 'Rotate your phone for a full-screen view in Field mode');
        }
    }

    /** True when the Field panel is the visible tab (not hidden by the tab system).
        Note: can't use offsetParent — it's null for the position:fixed landscape
        takeover panel even when fully visible. Use the hidden class + a non-zero box. */
    function fieldPanelVisible() {
        const panel = document.getElementById('panel-playByPlayField');
        if (!panel || panel.classList.contains('hidden')) return false;
        const r = panel.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    }

    /** Hint that field labels are long-pressable to flip sides, on first rotate to landscape. */
    function maybeShowFlipHint() {
        if (!fieldPanelVisible()) return;                 // only when the Field tab is showing
        if (window.hints && typeof window.hints.maybeShow === 'function') {
            window.hints.maybeShow('field-flip', 'Tip: long-press a field label (Home/Away/Attack/Defend) to flip sides');
        }
    }

    /**
     * Physical device rotation: force the layout to match. The spec calls for
     * rotation to drive orientation.
     */
    function onOrientationMQChange(e) {
        const isLandscape = (e && typeof e.matches === 'boolean')
            ? e.matches
            : window.matchMedia('(orientation: landscape)').matches;
        if (isLandscape && S.o !== 'landscape') {
            S.o = 'landscape';
            render();
            maybeShowFlipHint();   // first rotate to landscape: teach the label-flip gesture
        } else if (!isLandscape && S.o === 'landscape') {
            S.o = 'portrait';
            render();
        }
    }

    // -----------------------------------------------------------------
    // Wiring (per-render; elements are rebuilt each render)
    // -----------------------------------------------------------------
    function wireDynamic() {
        const root = document.getElementById('panel-playByPlayField-content');
        if (!root) return;

        const undoBtn = root.querySelector('#fpUndoBtn');
        if (undoBtn) undoBtn.onclick = handleUndo;

        // Game Events (timeout / injury sub / halftime / switch sides / end
        // game) — same modal as Simple/Full, routed through
        // handlePbpGameEvents so role checks stay consistent. Lives in the
        // action row (outside .fp-play's between-points greyout) so game
        // events stay reachable between points; the modal itself
        // enables/disables per point state (updateGameEventsModalState).
        const geBtn = root.querySelector('#fpGameEventsBtn');
        if (geBtn) geBtn.onclick = handlePbpGameEvents;

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
                else if (act === 'drop' || act === 'throwaway' || act === 'score') togglePending(act);
            };
        });
        root.querySelectorAll('.fp-modbtn[data-dmod]').forEach(b => {
            b.onclick = () => toggleDMod(b.dataset.dmod);
        });

        // Last-play tag chips: toggle a flag on the most recent event.
        root.querySelectorAll('.fp-modbtn[data-lastmod]').forEach(b => {
            b.onclick = () => toggleLastMod(b.dataset.lastmod);
        });

        // Set tag: tap cycles, long-press opens the full list.
        root.querySelectorAll('[data-setcycle]').forEach(b => {
            wireSetControl(b, {
                // Materialize the possession for the side in play if the first
                // event hasn't created it yet, rather than dropping the pick.
                getPossession: () => ensurePossessionExists(liveSetTarget(reconstructState()).wantOffensive),
                getLabels: () => liveSetTarget(reconstructState()).labels,
                canEdit: () => requireActiveCoach(),
                onChange: () => {
                    if (typeof saveAllTeamsData === 'function') saveAllTeamsData();
                    render();
                },
            });
        });

        // During pull, chips are tap-only (drag is disabled so the rail can
        // scroll). A plain click picks the puller.
        if (S.pulling) {
            root.querySelectorAll('.fp-rail .fp-chip[data-pname]').forEach(c => {
                c.onclick = () => handleChipTap(c.dataset.pname);
            });
        }

        // (Field taps are handled by the pointer layer above — no onclick.)
    }

    function wireEvents() { /* stable wiring handled per-render in wireDynamic */ }

    // -----------------------------------------------------------------
    // Init
    // -----------------------------------------------------------------
    function init() {
        loadFlips();
        render();
        if (window.narrationEventBus) {
            window.narrationEventBus.subscribe('eventAdded', render);
            window.narrationEventBus.subscribe('eventAmended', render);
            window.narrationEventBus.subscribe('eventRetracted', render);
            window.narrationEventBus.subscribe('pointChanged', render);
        }
        // Landscape rail must re-fit on width changes (window resize, panel
        // showing/hiding, fullscreen enter/exit). Coalesce bursts of resize
        // events into a single fit on the next task.
        let resizePending = 0;
        function scheduleFit() {
            if (resizePending) return;
            resizePending = setTimeout(() => { resizePending = 0; fitPlayers(); }, 0);
        }
        window.addEventListener('resize', scheduleFit);

        // Physical device rotation forces the matching orientation.
        const orientMQ = window.matchMedia('(orientation: landscape)');
        if (orientMQ.addEventListener) {
            orientMQ.addEventListener('change', onOrientationMQChange);
        } else if (orientMQ.addListener) {
            orientMQ.addListener(onOrientationMQChange);  // Safari < 14
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
    return {
        createPlayByPlayFieldPanel,
        render,
        wireEvents,
        beginPull,
        // Called by panelSystem when the Field tab becomes active.
        onTabShown: maybeShowRotateHint,
        // orientation flips (hamburger menu hooks)
        swapHomeAway: () => toggleFlip('ha'),
        swapAttackDefend: () => toggleFlip('ad'),
        // devtools helpers
        _state: S,
        _pct: pct,
        _toField: toField
    };
})();

// --- ES-module export ---
export { fieldPbp };
// window survivor: late-bound back-edge hook (namespace called window-qualified
// by ui/panelSystem.js, game/gameScreenPanels.js, game/gameScreenEvents.js,
// game/pointManagement.js — all evaluate before this file); also a devtools
// inspection seam (see above)
window.fieldPbp = fieldPbp;
