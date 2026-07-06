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
 * Coordinate system (STORED on events — orientation- AND size-INDEPENDENT,
 * NORMALIZED field frame). Each Throw/Turnover/Defense/Pull `from`/`to` is an
 * {x, y} with:
 *   - x = progress toward the ATTACKING endzone. x=0 at the DEFENDING endzone
 *     (goal) line, x=1 at the ATTACKING endzone (goal) line; x<0 is inside the
 *     defending endzone, x>1 is inside the attacking endzone.
 *   - y = across the field: y=0 at the HOME sideline, y=1 at the AWAY sideline.
 *
 * The normalized frame is deliberately decoupled from yards/meters and from the
 * endzone-depth setting: changing endzone depth (or playing a small 4v4/5v5/
 * middle-school field) only re-scales the endzone *margins* at render time and
 * never moves a stored point relative to the playing field. This supersedes the
 * old "canonical yards keyed off endzone depth" frame, which re-scaled past
 * games when the depth setting changed. The two display flips (flipAD / flipHA)
 * remain render-time only; stored {x, y} never change.
 *
 * At render time the normalized {x, y} is scaled to the on-screen field (whose
 * length includes the depth-dependent endzones) by pct()/toField(), which work
 * in canonical yards (EZ/L/W); toNorm()/fromNorm() bridge the two frames.
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
import { saveAllTeamsData } from '../store/storage.js';
import {
    currentGame, getLatestPoint, getPlayerFromName, isPointInProgress,
    determineStartingPosition,
} from '../utils/helpers.js';
import { undoEvent } from '../game/gameLogic.js';
import { startNextPoint } from '../game/pointManagement.js';
import { showControllerToast } from '../game/controllerState.js';
import { ensureDialogVisible, handlePbpTheyScore, handlePbpGameEvents } from '../game/gameScreenEvents.js';
import { handlePanelStartPoint } from '../game/selectLine.js';
import { showScoreAttributionDialog } from './scoreAttribution.js';

const fieldPbp = (function() {
    // -----------------------------------------------------------------
    // Field geometry (canonical yards). Width and the playing field proper are
    // fixed; endzone depth (EZ) comes from Advanced Settings (default 20 yd,
    // USAU; some leagues use 25). L and the red-zone/brick lines derive from
    // EZ, so they're refreshed from the setting on every render.
    //
    // These yards are a RENDER-ONLY frame: they map the on-screen field, whose
    // length includes the depth-dependent endzones. Stored event coordinates are
    // NOT in yards — they are the size-independent normalized {x, y} frame (see
    // the file header). toNorm()/fromNorm() bridge yards <-> normalized, so an
    // endzone-depth change re-scales only the endzone margins on screen and never
    // moves a stored point relative to the playing field.
    // -----------------------------------------------------------------
    const W = 40;                         // field width (fixed)
    const PLAYING = 70;                   // playing field proper, between goal lines (fixed)
    const BRICK_OFFSET = 20;              // brick mark: yards in from each goal line
    const LANES = [W / 3, 2 * W / 3];
    const VISIBLE = 4;                    // recent markers/arrows kept solid
    let EZ = 20;                          // endzone depth (refreshed from settings)
    let L = PLAYING + 2 * EZ;             // total length
    let RZ = [EZ + BRICK_OFFSET, L - EZ - BRICK_OFFSET];  // red-zone / brick lines
    let BRICK = RZ.slice();

    function refreshGeometry() {
        const y = (window.advancedSettings && typeof window.advancedSettings.getEndzoneYards === 'function')
            ? window.advancedSettings.getEndzoneYards() : 20;
        EZ = (Number.isFinite(y) && y > 0) ? y : 20;
        L = PLAYING + 2 * EZ;
        RZ = [EZ + BRICK_OFFSET, L - EZ - BRICK_OFFSET];
        BRICK = RZ.slice();
    }

    // -----------------------------------------------------------------
    // Stored-event coordinate frame: NORMALIZED {x, y} <-> canonical yards
    // {l, w}. Events are persisted as {x, y} (size-independent, see file
    // header); the render/tap math (pct/toField/clampLoc, the static geometry)
    // works in yards. These two converters are the ONLY bridge between the
    // frames. Each returns a FRESH object, so callers never alias coordinates.
    //   x = (l - EZ) / PLAYING   (0 at defending goal line, 1 at attacking)
    //   y = w / W                (0 at home sideline, 1 at away)
    // -----------------------------------------------------------------
    function toNorm(loc) {
        if (!loc) return null;
        return { x: (loc.l - EZ) / PLAYING, y: loc.w / W };
    }
    function fromNorm(n) {
        if (!n) return null;
        // New, normalized form.
        if (typeof n.x === 'number') return { l: EZ + n.x * PLAYING, w: n.y * W };
        // Tolerate any legacy canonical {l, w} so older data still renders.
        if (typeof n.l === 'number') return { l: n.l, w: n.w };
        return null;
    }

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

    // Rotation (deg) that makes on-field text readable from the Home side: the
    // text's "down" points toward the Home sideline. Portrait Home is a left/
    // right edge (±90°); landscape Home is the bottom/top edge (0/180°). Used
    // for the Home/Away labels and the big "Attacking" label, so they double
    // as a Home/Away cue.
    function homeSideRotation() {
        if (S.o === 'portrait') return S.flipHA ? -90 : 90;
        return S.flipHA ? 180 : 0;
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

    // Possession-change fade: markers demoted from the current segment fade
    // out over FADE_MS then drop — each demotion batch ("cohort") on its own
    // clock, so an icon fades exactly once and a finished fade never pops
    // back to full opacity when a later event moves the segment boundary
    // again. Implemented as a one-shot CSS animation (resumed via negative
    // animation-delay so re-renders don't restart it) plus a single delayed
    // re-render to drop finished cohorts — no continuous animation loop.
    const FADE_MS = 5000;
    const KEEP_SOLID = 4;     // newest located icons kept solid within the current possession
    let segCurStart = null;   // global event index where the solid window begins
    let segPointKey = null;   // stablePointKey of the point the indices refer to (reset on point change)
    let fadeCohorts = [];     // [{start, end, fadeStart}] — index ranges currently fading
    let fadeTimer = null;     // one-shot cleanup re-render at fade end

    function nowMs() {
        return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    }
    function scheduleFadeCleanup(remainingMs) {
        if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
        if (remainingMs > 0) fadeTimer = setTimeout(render, remainingMs + 60);
    }

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
            { label: 'Reset', flag: 'dump_flag' },
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
    // Coordinate mapping (mirrors the mockup's pct()/toField()).
    // -----------------------------------------------------------------
    function pct(l, w) {
        const ad = effFlipAD();
        const dl = ad ? (L - l) : l;
        const dw = S.flipHA ? (W - w) : w;
        return S.o === 'portrait'
            ? { x: ((W - dw) / W) * 100, y: ((L - dl) / L) * 100 }
            : { x: (dl / L) * 100, y: (dw / W) * 100 };
    }
    function toField(fx, fy) {
        let dl, dw;
        if (S.o === 'portrait') { dw = W - fx * W; dl = L - fy * L; }
        else { dl = fx * L; dw = fy * W; }
        return { l: effFlipAD() ? (L - dl) : dl, w: S.flipHA ? (W - dw) : dw };
    }
    // p is a STORED (normalized) coord. x>=1 is at/over the attacking goal line.
    function inAttackEZ(p) {
        if (!p) return false;
        if (typeof p.x === 'number') return p.x >= 1;
        if (typeof p.l === 'number') return p.l >= L - EZ;  // legacy {l,w}
        return false;
    }
    function clampLoc(l, w) {
        return { l: Math.max(1, Math.min(L - 1, l)), w: Math.max(1, Math.min(W - 1, w)) };
    }

    // -----------------------------------------------------------------
    // State derivation (shared possession core).
    // -----------------------------------------------------------------
    // Identity-stable key for a point. Cloud sync REPLACES game.points with
    // freshly deserialized objects (refreshGameStateFromCloud: the 3s poll for
    // non-Active-Coach sessions, and wake recovery for everyone), so object
    // identity can't distinguish "a different point" from "the same point,
    // new objects" — key on game id + point index instead. Null when there's
    // no game/point yet.
    function stablePointKey(point) {
        const game = (typeof currentGame === 'function') ? currentGame() : null;
        if (!game || !point || !game.points) return null;
        return `${game.id}#${game.points.indexOf(point)}`;
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

    // Which side of the disc an event represents: O for our offense (Throw /
    // Turnover), D for our defense (Pull / Defense). Violation/Other are
    // transparent — they attach to the surrounding run.
    function eventSide(e) {
        if (!e) return null;
        if (e.type === 'Throw' || e.type === 'Turnover') return 'O';
        if (e.type === 'Pull' || e.type === 'Defense') return 'D';
        return null;
    }

    /**
     * Split the flat event list into possession segments for fade rendering.
     * Returns {curStart, prevStart} as global indices: events >= curStart are
     * the current possession (solid), [prevStart, curStart) are the previous
     * possession (fading), and < prevStart are older (dropped).
     *
     * The current segment is the trailing run of same-side events. When the
     * last event itself flipped possession (its side differs from the
     * reconstructed mode — e.g. a block while we're now on offense with no O
     * event yet), that flip-causing event STAYS solid as the current segment:
     * the most recent icon is the coach's freshest landmark and must not fade
     * until the next icon lands (it joins its run's fade then). Older icons of
     * its run fade now; anything before drops.
     */
    function computeSegments(flat, mode) {
        let k = flat.length - 1;
        while (k >= 0 && eventSide(flat[k]) === null) k--;
        if (k < 0) return { curStart: flat.length, prevStart: -1 };

        const trailingSide = eventSide(flat[k]);
        const runStart = idx => {
            let s = idx;
            while (s - 1 >= 0) {
                const side = eventSide(flat[s - 1]);
                if (side === eventSide(flat[idx]) || side === null) s--; else break;
            }
            return s;
        };
        const cs = runStart(k);
        const reconSide = mode === 'offense' ? 'O' : 'D';

        if (trailingSide === reconSide) {
            const prevStart = (cs - 1 >= 0) ? runStart(cs - 1) : -1;
            return { curStart: cs, prevStart };
        }
        // Possession just flipped: the flip-causing event (index k) is the
        // whole current segment; the rest of its run fades.
        return { curStart: k, prevStart: (cs < k) ? cs : -1 };
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
    /**
     * Large background arrow labeled "Attacking" pointing at the attack
     * endzone. Direction follows orientation + effFlipAD: portrait up/down,
     * landscape left/right. Sized to ~50% of the field's long dimension via
     * CSS. The arrow shape flips direction; the text stays upright.
     */
    function attackArrowHTML() {
        const ad = effFlipAD();
        const port = S.o === 'portrait';
        const dir = port ? (ad ? 'down' : 'up') : (ad ? 'left' : 'right');
        const SHAPES = {
            up:    { vb: '0 0 200 320', pts: '100,12 184,120 132,120 132,306 68,306 68,120 16,120' },
            down:  { vb: '0 0 200 320', pts: '100,308 184,200 132,200 132,14 68,14 68,200 16,200' },
            right: { vb: '0 0 320 200', pts: '308,100 200,16 200,68 14,68 14,132 200,132 200,184' },
            left:  { vb: '0 0 320 200', pts: '12,100 120,16 120,68 306,68 306,132 120,132 120,184' }
        };
        const s = SHAPES[dir];
        // Text is a separate, CSS-rotated element (not SVG <text>) so it can
        // align with the arrow AND read from the Home side independently of the
        // arrow's pointing direction.
        return `<div class="fp-attack-arrow fp-aa-${port ? 'v' : 'h'}">`
            + `<svg viewBox="${s.vb}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">`
            + `<polygon class="fp-aa-shape" points="${s.pts}"/>`
            + `</svg></div>`
            + `<div class="fp-attack-label" style="transform:translate(-50%,-50%) rotate(${homeSideRotation()}deg)">Attacking</div>`;
    }

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

        // Big "Attacking" arrow pointing at the attack endzone — a background
        // cue so the direction of play is obvious at a glance. Behind the
        // labels/markers (added first), non-interactive.
        h += attackArrowHTML();

        const lab = (txt, l, w, flip, cls) => {
            const p = pct(l, w);
            // Home/Away labels rotate to read from the Home side (down toward
            // Home). Attack/Defend stay horizontal.
            const tf = (flip === 'ha')
                ? `;transform:translate(-50%,-50%) rotate(${homeSideRotation()}deg)`
                : '';
            return `<div class="${cls} fp-flbl" data-flip="${flip}" style="left:${p.x}%;top:${p.y}%${tf}">${txt}</div>`;
        };
        h += lab('Attack', L - EZ / 2, W / 2, 'ad', 'fp-ezlabel');
        h += lab('Defend', EZ / 2, W / 2, 'ad', 'fp-ezlabel');
        h += lab('Home', L / 2, W * 0.93, 'ha', 'fp-sidelbl');
        h += lab('Away', L / 2, W * 0.07, 'ha', 'fp-sidelbl');
        BRICK.forEach(l => {
            const p = pct(l, W / 2);
            h += `<div class="fp-brick" style="left:${p.x}%;top:${p.y}%">&times;</div>`;
        });

        // Located events, possession-aware (see computeSegments / the fade
        // module vars). The newest icons stay solid; everything demoted fades
        // in per-demotion cohorts over FADE_MS then drops for good. Within
        // the current possession only the last KEEP_SOLID located icons stay
        // solid — as new throws land, older ones demote — so a long
        // possession never accumulates a wall of arrows.
        const flat = pointEvents(state.point);
        const seg = computeSegments(flat, state.mode);
        const segNow = nowMs();
        // Solid window start: the KEEP_SOLIDth-newest located event in the
        // current segment (events without a location draw nothing and don't
        // consume slots). Short possessions show everything (floor = segment
        // start).
        let solidStart = seg.curStart;
        for (let gi = flat.length - 1, kept = 0; gi >= seg.curStart; gi--) {
            if (!flat[gi] || !flat[gi].to) continue;
            if (++kept === KEEP_SOLID) { solidStart = gi; break; }
        }
        // Keyed by stablePointKey, NOT object identity — sync refreshes
        // replace the Point objects and must not kill an in-flight fade.
        const segKey = stablePointKey(state.point);
        if (segPointKey !== segKey) {
            // New point (or first render): indices refer to a different event
            // list — reset, showing the solid window with no ghosts.
            segPointKey = segKey;
            segCurStart = solidStart;
            fadeCohorts = [];
        } else if (solidStart !== segCurStart) {
            if (solidStart > segCurStart) {
                // Icons demoted from the solid window start their one and
                // only fade now. Earlier cohorts keep their original clocks,
                // so a half- or fully-faded icon never resurrects when the
                // next event moves the boundary again.
                fadeCohorts.push({ start: segCurStart, end: solidStart, fadeStart: segNow });
            } else {
                // Boundary moved backwards (undo): whatever is solid again
                // must render fully — drop cohorts that overlap it.
                fadeCohorts = fadeCohorts.filter(c => c.end <= solidStart);
            }
            segCurStart = solidStart;
        }
        fadeCohorts = fadeCohorts.filter(c => segNow - c.fadeStart < FADE_MS);
        const cohortOf = gi => fadeCohorts.find(c => gi >= c.start && gi < c.end) || null;
        const shown = gi => gi >= solidStart || !!cohortOf(gi);
        // Negative animation-delay resumes each cohort's one-shot fade at the
        // right point across re-renders (no continuous loop).
        const fadeAnimFor = gi => {
            if (gi >= solidStart) return '';
            const c = cohortOf(gi);
            return c ? `;animation:fpFadeOut ${FADE_MS}ms linear ${(-(segNow - c.fadeStart)) | 0}ms forwards` : '';
        };

        // An arrow's tail sits on the previous located event's catch spot.
        // When that marker fades/drops, the arrow must go with it — otherwise
        // a "throw from nowhere" lingers, anchored to an empty spot. Each
        // arrow therefore inherits the faster of its own and its
        // predecessor's fade state.
        const prevLocated = [];
        {
            let lastLoc = -1;
            flat.forEach((e, gi) => { prevLocated[gi] = lastLoc; if (e && e.to) lastLoc = gi; });
        }
        let svg = `<svg class="fp-arrows" viewBox="0 0 100 100" preserveAspectRatio="none"><defs>`
            + `<marker id="fpah" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto">`
            + `<path d="M0,0 L5,2.5 L0,5 z" fill="#fff"/></marker></defs>`;
        flat.forEach((e, gi) => {
            if (!shown(gi) || !e.from || !e.to) return;
            const pgi = prevLocated[gi];
            if (pgi >= 0 && !shown(pgi)) return;   // tail anchor gone — drop the arrow
            const ef = fromNorm(e.from), et = fromNorm(e.to);
            const a = pct(ef.l, ef.w), b = pct(et.l, et.w);
            const dash = e.type === 'Pull' ? 'stroke-dasharray="3 2"' : '';
            const anim = fadeAnimFor(gi) || (pgi >= 0 ? fadeAnimFor(pgi) : '');
            const style = anim ? ` style="${anim.slice(1)}"` : '';
            svg += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${arrowColor(e)}" stroke-width="0.8" marker-end="url(#fpah)" ${dash} vector-effect="non-scaling-stroke"${style}/>`;
        });
        svg += `</svg>`;
        h += svg;

        flat.forEach((e, gi) => {
            if (!shown(gi) || !e.to) return;
            const et = fromNorm(e.to);
            const p = pct(et.l, et.w);
            const m = markerStyle(e, gi);
            // All shown markers (current + fading) are draggable so a
            // previous location can be adjusted during the fade window.
            const fade = fadeAnimFor(gi);
            h += `<div class="fp-marker ${m.cls}" data-mkidx="${gi}" style="left:${p.x}%;top:${p.y}%${fade}">${m.glyph}</div>`;
        });

        // Disc at the current holder's location: explicit pickup spot, else the
        // last located event in the CURRENT segment (never a faded prior one).
        let discPos = S.pickupLoc || null;
        if (!discPos) {
            for (let gi = flat.length - 1; gi >= seg.curStart; gi--) {
                if (flat[gi] && flat[gi].to) { discPos = flat[gi].to; break; }
            }
        }
        if (discPos) {
            const dl = fromNorm(discPos);
            const d = pct(dl.l, dl.w);
            h += `<div class="fp-disc" style="left:${d.x}%;top:${d.y}%"></div>`;
        }

        // One delayed re-render to drop fading icons when the last cohort ends.
        scheduleFadeCleanup(fadeCohorts.reduce((m, c) => Math.max(m, FADE_MS - (segNow - c.fadeStart)), 0));

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
                <button class="fp-gameevents" id="fpGameEventsBtn" title="Timeout, injury sub, halftime, switch sides, end game"><i class="fas fa-cog"></i><span>Events</span></button>
                <button class="fp-undo" id="fpUndoBtn" title="Undo last event"><i class="fas fa-undo"></i><span>Undo</span></button>
            </div>
            <div class="fp-play${inPoint ? '' : ' fp-between-points'}">
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
        const from = toNorm({ l: EZ, w: W / 2 });
        const to = brick ? toNorm({ l: BRICK[1], w: W / 2 }) : toNorm(clampLoc(l, w));

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
     *   - reset (dump_flag): meaningfully backwards (beyond a small tolerance
     *            so flat lateral passes don't count)
     *   - swing: crosses a lateral field third, unless it's a huck (a deep
     *            cross-field shot reads as a huck, not a swing)
     */
    const RESET_TOLERANCE = 0.025;   // ~1.75 yd backwards on a 70 yd playing field
    function classifyThrow(from, to) {
        if (!from || !to || typeof from.x !== 'number' || typeof to.x !== 'number') return {};
        const dx = to.x - from.x;
        let huckFrac = 0.5;
        if (window.advancedSettings && typeof window.advancedSettings.get === 'function') {
            const v = parseFloat(window.advancedSettings.get('field.huckFraction'));
            if (Number.isFinite(v) && v > 0) huckFrac = v;
        }
        const huck = dx >= huckFrac;
        const dump = dx <= -RESET_TOLERANCE;
        const third = y => y < 1 / 3 ? 0 : (y <= 2 / 3 ? 1 : 2);
        const swing = !huck && typeof from.y === 'number' && typeof to.y === 'number'
            && third(from.y) !== third(to.y);
        return { huck, dump, swing };
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
    function handleMore() {
        // D overflow (footblock / handblock / bid / …) lands in Phase 7.
        console.log('[fieldPbp] D "⋯ more" overflow (phase 7)');
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
        names.forEach(name => {
            if (excludeName && name === excludeName) return;
            const p = playerByName(name); if (!p) return;
            const lead = (p.number != null) ? `<span class="fp-num">${p.number}</span>` : '';
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
     * a Throw whose endpoints changed (marker drag). Overwrites exactly those
     * three flags from the new geometry — same rule as at commit time; other
     * flags (break, hammer, sky, layout) are untouched.
     */
    function reclassifyThrow(ev) {
        if (!ev || ev.type !== 'Throw' || !ev.from || !ev.to) return;
        const c = classifyThrow(ev.from, ev.to);
        ev.huck_flag = !!c.huck;
        ev.dump_flag = !!c.dump;
        ev.swing_flag = !!c.swing;
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
                else if (act === 'more') handleMore();
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
