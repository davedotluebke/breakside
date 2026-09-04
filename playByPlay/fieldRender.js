/*
 * Field renderer (shared, non-interactive)
 *
 * Draws the pitch and everything on it — endzones, lines, labels, the big
 * "Attacking" arrow, located-event arrows / markers / the disc, player chips,
 * and an optional layer of positioned player icons — for any surface that
 * needs a field: the Field PBP tab (playByPlay/fieldPbp.js) and the replay
 * viewer (docs/replay-viewer-plan.md). Nothing here reads interactive state;
 * every function takes an explicit `view` and the data to draw. Nothing here
 * touches the DOM at import time (node-importable for unit tests).
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
 * The `view` object every render-time function takes:
 *   {
 *     o:      'portrait' | 'landscape',
 *     flipAD: boolean,   // EFFECTIVE attack flip (the Field tab XORs its base
 *                        // setting with point parity before passing it in)
 *     flipHA: boolean,   // which sideline is Home
 *   }
 * The owner of the view (the Field tab, the replay) keeps and persists the
 * flips; this module only reads them. (ARCHITECTURE.md § Field PBP spatial
 * coordinate frame is the prose copy of this header; keep the two in sync.)
 */
import { showPlayerNumbers } from '../utils/helpers.js';

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
//
// The EZ-derived values live on one mutable `geom` object (rather than
// module-level lets) so importers always read the current value.
// -----------------------------------------------------------------
export const W = 40;                         // field width (fixed)
export const PLAYING = 70;                   // playing field proper, between goal lines (fixed)
export const BRICK_OFFSET = 20;              // brick mark: yards in from each goal line
export const LANES = [W / 3, 2 * W / 3];
export const geom = {
    EZ: 20,                                  // endzone depth (refreshed from settings)
    L: PLAYING + 2 * 20,                     // total length
    RZ: [20 + BRICK_OFFSET, PLAYING + 2 * 20 - 20 - BRICK_OFFSET],  // red-zone / brick lines
    BRICK: [20 + BRICK_OFFSET, PLAYING + 2 * 20 - 20 - BRICK_OFFSET],
};

/**
 * Re-read the endzone depth. With no argument it reads Advanced Settings
 * (the production path); an explicit positive `yards` overrides it (tests).
 */
export function refreshGeometry(yards) {
    let y = yards;
    if (!(Number.isFinite(y) && y > 0)) {
        y = (typeof window !== 'undefined' && window.advancedSettings
            && typeof window.advancedSettings.getEndzoneYards === 'function')
            ? window.advancedSettings.getEndzoneYards() : 20;
    }
    geom.EZ = (Number.isFinite(y) && y > 0) ? y : 20;
    geom.L = PLAYING + 2 * geom.EZ;
    geom.RZ = [geom.EZ + BRICK_OFFSET, geom.L - geom.EZ - BRICK_OFFSET];
    geom.BRICK = geom.RZ.slice();
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
export function toNorm(loc) {
    if (!loc) return null;
    return { x: (loc.l - geom.EZ) / PLAYING, y: loc.w / W };
}
export function fromNorm(n) {
    if (!n) return null;
    // New, normalized form.
    if (typeof n.x === 'number') return { l: geom.EZ + n.x * PLAYING, w: n.y * W };
    // Tolerate any legacy canonical {l, w} so older data still renders.
    if (typeof n.l === 'number') return { l: n.l, w: n.w };
    return null;
}

// -----------------------------------------------------------------
// Coordinate mapping (mirrors the mockup's pct()/toField()). pct() maps
// canonical yards to on-screen percentages for the given view; toField()
// is its inverse (screen fractions -> yards).
// -----------------------------------------------------------------
export function pct(view, l, w) {
    const { L } = geom;
    const dl = view.flipAD ? (L - l) : l;
    const dw = view.flipHA ? (W - w) : w;
    return view.o === 'portrait'
        ? { x: ((W - dw) / W) * 100, y: ((L - dl) / L) * 100 }
        : { x: (dl / L) * 100, y: (dw / W) * 100 };
}
export function toField(view, fx, fy) {
    const { L } = geom;
    let dl, dw;
    if (view.o === 'portrait') { dw = W - fx * W; dl = L - fy * L; }
    else { dl = fx * L; dw = fy * W; }
    return { l: view.flipAD ? (L - dl) : dl, w: view.flipHA ? (W - dw) : dw };
}
// p is a STORED (normalized) coord. x>=1 is at/over the attacking goal line.
export function inAttackEZ(p) {
    if (!p) return false;
    if (typeof p.x === 'number') return p.x >= 1;
    if (typeof p.l === 'number') return p.l >= geom.L - geom.EZ;  // legacy {l,w}
    return false;
}
export function clampLoc(l, w) {
    return { l: Math.max(1, Math.min(geom.L - 1, l)), w: Math.max(1, Math.min(W - 1, w)) };
}

// Rotation (deg) that makes on-field text readable from the Home side: the
// text's "down" points toward the Home sideline. Portrait Home is a left/
// right edge (±90°); landscape Home is the bottom/top edge (0/180°). Used
// for the Home/Away labels and the big "Attacking" label, so they double
// as a Home/Away cue.
export function homeSideRotation(view) {
    if (view.o === 'portrait') return view.flipHA ? -90 : 90;
    return view.flipHA ? 180 : 0;
}

// -----------------------------------------------------------------
// Static layers: endzones, lines, the attack arrow, labels, brick marks.
// -----------------------------------------------------------------
/**
 * Large background arrow labeled "Attacking" pointing at the attack
 * endzone. Direction follows orientation + flipAD: portrait up/down,
 * landscape left/right. Sized to ~50% of the field's long dimension via
 * CSS. The arrow shape flips direction; the text stays upright.
 */
export function attackArrowHTML(view) {
    const ad = view.flipAD;
    const port = view.o === 'portrait';
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
        + `<div class="fp-attack-label" style="transform:translate(-50%,-50%) rotate(${homeSideRotation(view)}deg)">Attacking</div>`;
}

/** Endzones, goal/red-zone/lane lines, attack arrow, labels, brick marks. */
export function staticFieldHTML(view) {
    const { EZ, L, RZ, BRICK } = geom;
    let h = '';
    const port = view.o === 'portrait';

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
    h += attackArrowHTML(view);

    const lab = (txt, l, w, flip, cls) => {
        const p = pct(view, l, w);
        // Home/Away labels rotate to read from the Home side (down toward
        // Home). Attack/Defend stay horizontal.
        const tf = (flip === 'ha')
            ? `;transform:translate(-50%,-50%) rotate(${homeSideRotation(view)}deg)`
            : '';
        return `<div class="${cls} fp-flbl" data-flip="${flip}" style="left:${p.x}%;top:${p.y}%${tf}">${txt}</div>`;
    };
    h += lab('Attack', L - EZ / 2, W / 2, 'ad', 'fp-ezlabel');
    h += lab('Defend', EZ / 2, W / 2, 'ad', 'fp-ezlabel');
    h += lab('Home', L / 2, W * 0.93, 'ha', 'fp-sidelbl');
    h += lab('Away', L / 2, W * 0.07, 'ha', 'fp-sidelbl');
    BRICK.forEach(l => {
        const p = pct(view, l, W / 2);
        h += `<div class="fp-brick" style="left:${p.x}%;top:${p.y}%">&times;</div>`;
    });
    return h;
}

// -----------------------------------------------------------------
// Possession segmentation + fade cohorts (event layer).
// -----------------------------------------------------------------
// Identity-stable key for a point. Cloud sync REPLACES game.points with
// freshly deserialized objects (refreshGameStateFromCloud: the 3s poll for
// non-Active-Coach sessions, and wake recovery for everyone), so object
// identity can't distinguish "a different point" from "the same point,
// new objects" — key on game id + point index instead. Null when there's
// no game/point yet.
export function stablePointKey(game, point) {
    if (!game || !point || !game.points) return null;
    return `${game.id}#${game.points.indexOf(point)}`;
}

// Which side of the disc an event represents: O for our offense (Throw /
// Turnover), D for our defense (Pull / Defense). Violation/Other are
// transparent — they attach to the surrounding run.
export function eventSide(e) {
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
export function computeSegments(flat, mode) {
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

// Possession-change fade: markers demoted from the current segment fade
// out over FADE_MS then drop — each demotion batch ("cohort") on its own
// clock, so an icon fades exactly once and a finished fade never pops
// back to full opacity when a later event moves the segment boundary
// again. Implemented as a one-shot CSS animation (resumed via negative
// animation-delay so re-renders don't restart it) plus a single delayed
// re-render to drop finished cohorts — no continuous animation loop.
export const FADE_MS = 5000;
export const KEEP_SOLID = 4;     // newest located icons kept solid within the current possession

export function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/**
 * Per-instance fade state. Each field on screen owns one tracker (the Field
 * tab and a replay must not share a boundary/cohort list). `onCleanup` is
 * the owner's re-render, invoked once when the last fading cohort ends.
 *
 * advance(pointKey, solidStart, now) moves the solid-window boundary for a
 * render and returns { shown(gi), fadeAnimFor(gi) } for that render's
 * event indices.
 */
export function createFadeTracker(onCleanup) {
    let segCurStart = null;   // global event index where the solid window begins
    let segPointKey = null;   // stablePointKey of the point the indices refer to (reset on point change)
    let fadeCohorts = [];     // [{start, end, fadeStart}] — index ranges currently fading
    let fadeTimer = null;     // one-shot cleanup re-render at fade end

    function scheduleFadeCleanup(remainingMs) {
        if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
        if (remainingMs > 0 && typeof onCleanup === 'function') {
            fadeTimer = setTimeout(onCleanup, remainingMs + 60);
        }
    }

    function advance(pointKey, solidStart, now) {
        const segNow = (typeof now === 'number') ? now : nowMs();
        // Keyed by stablePointKey, NOT object identity — sync refreshes
        // replace the Point objects and must not kill an in-flight fade.
        if (segPointKey !== pointKey) {
            // New point (or first render): indices refer to a different event
            // list — reset, showing the solid window with no ghosts.
            segPointKey = pointKey;
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
        // One delayed re-render to drop fading icons when the last cohort ends.
        scheduleFadeCleanup(fadeCohorts.reduce((m, c) => Math.max(m, FADE_MS - (segNow - c.fadeStart)), 0));
        return { shown, fadeAnimFor };
    }

    function dispose() {
        if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }
    }

    return { advance, dispose };
}

// -----------------------------------------------------------------
// Event layer: located-event arrows, markers, and the disc.
// -----------------------------------------------------------------
export function arrowColor(e) {
    if (e.type === 'Pull') return '#e5e7eb';
    if (e.type === 'Throw') return e.score_flag ? '#34d399' : '#bfdbfe';
    if (e.type === 'Turnover') return '#fca5a5';
    if (e.type === 'Defense') return '#34d399';
    return '#bfdbfe';
}
export function markerStyle(e, idx) {
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

/**
 * Located events, possession-aware (see computeSegments / the fade
 * tracker). The newest icons stay solid; everything demoted fades in
 * per-demotion cohorts over FADE_MS then drops for good. Within the
 * current possession only the last KEEP_SOLID located icons stay solid —
 * as new throws land, older ones demote — so a long possession never
 * accumulates a wall of arrows.
 *
 * opts: {
 *   events:   flat event list for the point (all possessions, in order)
 *   mode:     'offense' | 'defense' — the reconstructed live mode
 *   pointKey: stablePointKey() of the point (fade tracker reset key)
 *   discLoc:  normalized {x, y} | null — explicit disc spot (pickup) that
 *             overrides "last located event in the current segment"
 *   fade:     createFadeTracker() instance | null (null = no fading; only
 *             the solid window renders)
 * }
 */
export function eventLayerHTML(view, opts) {
    const flat = opts.events || [];
    const seg = computeSegments(flat, opts.mode);
    // Solid window start: the KEEP_SOLIDth-newest located event in the
    // current segment (events without a location draw nothing and don't
    // consume slots). Short possessions show everything (floor = segment
    // start).
    let solidStart = seg.curStart;
    for (let gi = flat.length - 1, kept = 0; gi >= seg.curStart; gi--) {
        if (!flat[gi] || !flat[gi].to) continue;
        if (++kept === KEEP_SOLID) { solidStart = gi; break; }
    }
    const { shown, fadeAnimFor } = opts.fade
        ? opts.fade.advance(opts.pointKey, solidStart, nowMs())
        : { shown: gi => gi >= solidStart, fadeAnimFor: () => '' };

    let h = '';
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
        const a = pct(view, ef.l, ef.w), b = pct(view, et.l, et.w);
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
        const p = pct(view, et.l, et.w);
        const m = markerStyle(e, gi);
        // All shown markers (current + fading) carry their event index so
        // an interactive owner can drag them (a previous location can be
        // adjusted during the fade window).
        const fade = fadeAnimFor(gi);
        h += `<div class="fp-marker ${m.cls}" data-mkidx="${gi}" style="left:${p.x}%;top:${p.y}%${fade}">${m.glyph}</div>`;
    });

    // Disc at the current holder's location: explicit pickup spot, else the
    // last located event in the CURRENT segment (never a faded prior one).
    let discPos = opts.discLoc || null;
    if (!discPos) {
        for (let gi = flat.length - 1; gi >= seg.curStart; gi--) {
            if (flat[gi] && flat[gi].to) { discPos = flat[gi].to; break; }
        }
    }
    if (discPos) {
        const dl = fromNorm(discPos);
        const d = pct(view, dl.l, dl.w);
        h += `<div class="fp-disc" style="left:${d.x}%;top:${d.y}%"></div>`;
    }
    return h;
}

/** The whole field: static layers followed by the event layer (see eventLayerHTML for opts). */
export function fieldHTML(view, opts) {
    return staticFieldHTML(view) + eventLayerHTML(view, opts);
}

// -----------------------------------------------------------------
// Player chips (rail) + the actor layer.
// -----------------------------------------------------------------
/** Jersey-number lead-in, honoring the display.showPlayerNumbers setting. */
function numberLeadHTML(player) {
    return (player.number != null && showPlayerNumbers()) ? `<span class="fp-num">${player.number}</span>` : '';
}

export function chipHTML(player, opts) {
    opts = opts || {};
    const cls = ['fp-chip'];
    if (opts.unknown) cls.push('unknown');
    if (opts.holder) cls.push('holder');
    if (opts.armed) cls.push('armed');
    const lead = opts.unknown
        ? `<span class="fp-umark">?</span>`
        : numberLeadHTML(player);
    const label = opts.unknown ? 'Unknown' : player.name;
    return `<div class="${cls.join(' ')}" data-pname="${player.name}">${lead}<span class="fp-nm">${label}</span></div>`;
}

/**
 * Actor layer: player icons at given positions on the pitch (the replay
 * viewer's "where everyone is" view; the Field tab does not render it).
 *
 *   positions: { [name]: {x, y} } — normalized field coords per player
 *   opts: {
 *     players:  name => { name, number } | null   (display info; a missing
 *               entry renders the bare name)
 *     holder:   name of the player with the disc (gets the `holder` class)
 *     durMs:    transition duration for this render, written to `--fp-dur`
 *               on the layer (0 = jump, e.g. on seek)
 *   }
 *
 * Positions animate through CSS transitions on left/top (fieldPbp.css
 * "Actor layer"), which only run when an EXISTING element's style changes —
 * so a per-frame owner should patch with applyActorPositions() rather than
 * rebuild the DOM.
 */
export function actorLayerHTML(view, positions, opts) {
    opts = opts || {};
    const dur = Number.isFinite(opts.durMs) ? opts.durMs : 0;
    let h = `<div class="fp-actors" style="--fp-dur:${dur}ms">`;
    Object.keys(positions || {}).forEach(name => {
        const p = fromNorm(positions[name]);
        if (!p) return;
        const q = pct(view, p.l, p.w);
        const info = (typeof opts.players === 'function' && opts.players(name)) || { name };
        const cls = ['fp-actor'];
        if (opts.holder === name) cls.push('holder');
        h += `<div class="${cls.join(' ')}" data-pname="${name}" style="left:${q.x}%;top:${q.y}%">`
            + `${numberLeadHTML(info)}<span class="fp-nm">${info.name || name}</span></div>`;
    });
    return h + `</div>`;
}

/**
 * Move an already-rendered actor layer to new positions in place, so the CSS
 * transitions run. Players absent from `positions` are removed; new ones are
 * appended (they appear without a transition).
 */
export function applyActorPositions(layerEl, view, positions, opts) {
    if (!layerEl) return;
    opts = opts || {};
    positions = positions || {};
    layerEl.style.setProperty('--fp-dur', `${Number.isFinite(opts.durMs) ? opts.durMs : 0}ms`);
    const seen = new Set();
    Array.from(layerEl.querySelectorAll('.fp-actor[data-pname]')).forEach(el => {
        const name = el.dataset.pname;
        const p = fromNorm(positions[name]);
        if (!p) { el.remove(); return; }
        seen.add(name);
        const q = pct(view, p.l, p.w);
        el.style.left = `${q.x}%`;
        el.style.top = `${q.y}%`;
        el.classList.toggle('holder', opts.holder === name);
    });
    const missing = {};
    Object.keys(positions).forEach(name => { if (!seen.has(name)) missing[name] = positions[name]; });
    if (Object.keys(missing).length) {
        // Render the newcomers through the same template, then adopt them.
        const tmp = document.createElement('div');
        tmp.innerHTML = actorLayerHTML(view, missing, opts);
        Array.from(tmp.firstElementChild.children).forEach(el => layerEl.appendChild(el));
    }
}
