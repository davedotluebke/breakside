/*
 * Replay View — the Log tab's field playback (docs/replay-viewer-plan.md
 * step 6) and, mounted with a finished game, the post-game summary's.
 *
 * Composition: a STAGE (the Field tab's pitch, drawn by
 * playByPlay/fieldRender.js, with an Offense/Defense badge beside or above
 * it) over a TRANSPORT bar (⏮ ▶ ⏭ · slider Live · 1× · 2× · 4× · Speedy · ⟳
 * rotate) over a point TIMELINE, all sitting on top of the existing game-log
 * lines. The log itself is untouched: lines come from
 * renderGameLogEntriesHTML (each carries data-entry), and this module only
 * adds rv-cur / rv-future classes and a tap-to-seek handler.
 *
 * Collapse rules (Decisions 5 and 10): when the game has NO located events at
 * all, nothing is mounted and the Log tab looks exactly as before; when the
 * point under the playhead has none, the stage collapses to a one-line
 * banner so the log keeps the room.
 *
 * The clock lives in replayController; the derivations in replayEngine. This
 * module is the only one that touches the DOM. It is late-bound from
 * ui/panelSystem (tab shown/hidden) and game/gameScreenSync (log re-rendered)
 * through window.replayView — those modules sit above this layer.
 */
import { createReplayEngine } from './replayEngine.js';
import { createReplayController } from './replayController.js';
import * as fieldRender from './fieldRender.js';
import { createReplayEditor } from './replayEdit.js';
import { advancedSettings } from '../settings/advancedSettings.js';

// Slider stops. 'pap' (the engine's play-after-play) is surfaced as "Speedy":
// 4× animation with no dead time at all — each play fires as soon as the
// previous animation lands.
const SPEED_STOPS = ['live', 1, 2, 4, 'pap'];
const SPEED_LABELS = ['Live', '1×', '2×', '4×', 'Speedy'];
const SPEEDY_FACTOR = 4;
const SPEEDY_HOLD_MS = 250;

// Inline icons (no Font Awesome dependency: the CDN font is the one thing
// this offline-first app can't count on, and a transport bar with blank
// buttons is unusable). 16px viewBox, currentColor.
const ICON = {
    play:   '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 2.5v11l9-5.5z"/></svg>',
    pause:  '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M3.5 2.5h3.5v11H3.5zM9 2.5h3.5v11H9z"/></svg>',
    prev:   '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2.5 2.5h2v11h-2zM13.5 2.5v11L5.5 8z"/></svg>',
    next:   '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M11.5 2.5h2v11h-2zM2.5 2.5v11L10.5 8z"/></svg>',
    rotate: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" d="M13 8a5 5 0 1 1-1.6-3.7"/><path fill="currentColor" d="M13.5 1.5v4h-4z"/></svg>',
    edit:   '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M11.3 1.9a1.5 1.5 0 0 1 2.1 0l.7.7a1.5 1.5 0 0 1 0 2.1L6 12.8l-3.6.8.8-3.6zM10.6 3.7l1.7 1.7 1-1-1.7-1.7zM4.4 10l-.4 1.9 1.9-.4 5.3-5.3-1.5-1.5z"/></svg>',
};

/**
 * Mount a replay view.
 * @param {object} cfg
 * @param {HTMLElement} cfg.host - element the stage/transport/timeline are inserted into (prepended)
 * @param {HTMLElement} cfg.logEl - the element holding the rendered game-log lines (data-entry divs)
 * @param {() => object} cfg.getGame - returns the current game object (re-read on every refresh)
 * @param {() => object} cfg.getEntryOptions - the buildGameLogEntries options the LOG was rendered
 *   with (teamName/opponentName/versionInfo/rosterNames/resolvePlayerName) — the engine must build
 *   the same entry list so indices line up with the log's data-entry attributes
 * @param {(name: string) => object|null} [cfg.getPlayerByName] - display info (jersey number) for actor labels
 * @param {boolean} [cfg.live] - offer Live (follow the tail); false for finished games
 * @param {() => boolean} [cfg.canEdit] - editing gate (playByPlay/replayEdit.js); absent = no Edit button
 * @param {string} [cfg.editDeniedMessage] - toast when canEdit() refuses
 * @param {() => void} [cfg.onEdited] - called after every amendment so the mount site can
 *   re-render its log lines / stats; the view refreshes itself regardless
 * @returns {{refresh:Function, onLogUpdated:Function, onShown:Function, onHidden:Function, destroy:Function, controller:object, engine:object, root:HTMLElement}|null}
 *   null when the game has no located events (nothing mounted)
 */
function mountReplayView(cfg) {
    const { host, logEl, getGame, getEntryOptions } = cfg;
    if (!host || !logEl) return null;
    const settings = advancedSettings.getReplaySettings();
    const engine = createReplayEngine(getGame(), Object.assign({
        capWithinMs: settings.capWithinMs, capBetweenMs: settings.capBetweenMs,
        papHoldMs: SPEEDY_HOLD_MS,
    }, getEntryOptions()));
    if (!engine.gameHasLocations()) return null;

    const controller = createReplayController(engine);
    const live = cfg.live !== false && !engine.isFinished();
    let orientation = settings.orientation;

    // ---- DOM ----
    const root = document.createElement('div');
    root.className = 'rv-root';
    root.innerHTML = `
        <div class="rv-stage" data-o="${orientation}">
            <div class="rv-possbanner"></div>
            <div class="rv-fieldwrap"><div class="fp-field rv-field"></div></div>
        </div>
        <div class="rv-nofield">No field positions were recorded for this point</div>
        <div class="rv-transport">
            <button class="rv-tbtn rv-prev" title="Previous play" aria-label="Previous play">${ICON.prev}</button>
            <button class="rv-tbtn rv-play" title="Play" aria-label="Play">${ICON.play}</button>
            <button class="rv-tbtn rv-next" title="Next play" aria-label="Next play">${ICON.next}</button>
            <div class="rv-speed">
                <input type="range" class="rv-speed-input" min="0" max="4" step="1" value="1" aria-label="Playback speed">
                <div class="rv-ticks">${SPEED_LABELS.map(l => `<span>${l}</span>`).join('')}</div>
            </div>
            <button class="rv-tbtn rv-rotate" title="Rotate field" aria-label="Rotate field">${ICON.rotate}</button>
            <button class="rv-tbtn rv-editbtn" title="Edit play" aria-label="Edit play" hidden>${ICON.edit}</button>
        </div>
        <div class="rv-timeline" title="Points — tap or drag to scrub"><div class="rv-head"></div></div>
        <button class="rv-golive" hidden></button>
    `;
    host.insertBefore(root, host.firstChild);
    const q = sel => root.querySelector(sel);
    const stageEl = q('.rv-stage'), fieldEl = q('.rv-field'), bannerEl = q('.rv-possbanner');
    const playBtn = q('.rv-play'), prevBtn = q('.rv-prev'), nextBtn = q('.rv-next');
    const speedInput = q('.rv-speed-input'), ticksEl = q('.rv-ticks');
    const timelineEl = q('.rv-timeline'), headEl = q('.rv-head'), goLiveBtn = q('.rv-golive');
    const editBtn = q('.rv-editbtn');
    if (!live) { ticksEl.firstElementChild.classList.add('disabled'); }
    const editable = typeof cfg.canEdit === 'function';
    editBtn.hidden = !editable;

    // ---- field adapter (playByPlay/fieldRender.js) ----
    // The pitch is the Field tab's: static layers + the located-event layer
    // (arrows / markers, with the same fade-out of demoted plays) come from
    // fieldRender; on top sit the actor layer (player labels at reconstructed
    // positions, fading with the event that placed them) and our own
    // persistent disc element, both moved in place so CSS transitions carry
    // the motion. The event layer's own disc is hidden by replayView.css — a
    // rebuilt element can't animate.
    const view = { o: orientation, flipAD: false, flipHA: false };
    let shown = true;
    let staticFor = null;          // orientation the static layers were drawn for
    let eventLayerEl = null, actorLayerEl = null, discEl = null;
    let lastDrawn = { index: -1, state: null };
    const fade = fieldRender.createFadeTracker(() => { if (shown && lastDrawn.state) drawField(lastDrawn.index, lastDrawn.state, false); });

    function ensureFieldDom() {
        if (staticFor === view.o && eventLayerEl) return;
        fieldRender.refreshGeometry();
        fieldEl.innerHTML = fieldRender.staticFieldHTML(view)
            + '<div class="rv-eventlayer"></div>'
            + fieldRender.actorLayerHTML(view, {}, {})
            + '<div class="fp-disc rv-disc" hidden></div>';
        eventLayerEl = fieldEl.querySelector('.rv-eventlayer');
        actorLayerEl = fieldEl.querySelector('.fp-actors');
        discEl = fieldEl.querySelector('.rv-disc');
        staticFor = view.o;
    }

    function pointEventsUpto(index) {
        const pointIdx = engine.pointOf(index);
        if (pointIdx === null) return { point: null, events: [] };
        const point = (engine.game.points || [])[pointIdx];
        const events = [];
        for (let i = engine.pointRange(pointIdx).first; i <= index; i++) {
            const e = engine.entries[i];
            if ((e.kind === 'event' || e.kind === 'after') && e.event) events.push(e.event);
        }
        return { point, events };
    }

    function speedFactor() {
        const s = controller.state.speed;
        if (s === 'pap') return SPEEDY_FACTOR;
        return typeof s === 'number' && s > 0 ? s : 1;
    }

    /** Animation length for the move that entry `index` causes, ms. */
    function animMs(index, animate) {
        if (!animate) return 0;
        const e = engine.entries[index];
        if (!e || e.kind !== 'event' || !e.event) return 0;
        const ev = e.event;
        const speed = speedFactor();
        if (ev.type === 'Pull') return Math.min(typeof ev.hang === 'number' && ev.hang > 0 ? ev.hang : 1500, 2500) / speed;
        if (!ev.to) return 0;
        if (!ev.from) return 450 / speed;
        const d = Math.hypot(ev.to.x - ev.from.x, (ev.to.y - ev.from.y) * 0.57);
        return Math.max(350, Math.min(1100, d * 1400)) / speed;
    }

    const playerInfo = name => {
        const p = typeof cfg.getPlayerByName === 'function' ? cfg.getPlayerByName(name) : null;
        return { name, number: p && p.number != null ? p.number : null };
    };

    function moveDisc(loc, dur) {
        if (!loc) { discEl.hidden = true; return; }
        const yd = fieldRender.fromNorm(loc);
        const q = fieldRender.pct(view, yd.l, yd.w);
        const wasHidden = discEl.hidden;
        discEl.hidden = false;
        // A hidden→shown disc jumps; a visible one glides (transition on left/top).
        discEl.style.transitionDuration = wasHidden ? '0ms' : `${dur}ms`;
        discEl.style.left = `${q.x}%`;
        discEl.style.top = `${q.y}%`;
        discEl.classList.remove('rv-fly');
        if (!wasHidden && dur > 0) { void discEl.offsetWidth; discEl.style.animationDuration = `${dur}ms`; discEl.classList.add('rv-fly'); }
    }

    /**
     * Which event (index into the point's event list) put each player where
     * they stand — so a label fades and drops with that event's marker.
     */
    function placedByEvent(events) {
        const placed = {};
        const set = (ref, loc, gi) => {
            const n = ref && typeof ref === 'object' ? ref.name : (typeof ref === 'string' ? ref : null);
            if (n && loc && typeof loc.x === 'number') placed[n] = gi;
        };
        events.forEach((e, gi) => {
            if (e.type === 'Throw') { set(e.thrower, e.from, gi); set(e.receiver, e.to, gi); }
            else if (e.type === 'Turnover') set(e.thrower, e.from, gi);
            else if (e.type === 'Defense') set(e.defender, e.to, gi);
            else if (e.type === 'Pull') set(e.puller, e.from, gi);
        });
        return placed;
    }

    function drawField(index, state, animate) {
        lastDrawn = { index, state };
        const pointIdx = state.pointIdx;
        const located = pointIdx !== null && engine.hasLocations(pointIdx);
        root.classList.toggle('rv-collapsed', !located);
        if (!located) return 0;
        ensureFieldDom();
        const { point, events } = pointEventsUpto(index);
        const dur = animMs(index, animate);
        const mode = state.who === 'us' ? 'offense'
            : state.who === 'opp' ? 'defense'
            : ((point && point.startingPosition === 'defense') ? 'defense' : 'offense');
        const visibility = {};
        eventLayerEl.innerHTML = fieldRender.eventLayerHTML(view, {
            events, mode,
            pointKey: fieldRender.stablePointKey(engine.game, point),
            discLoc: state.disc, fade, visibility,
        });
        // Actors follow their placing event's marker: shown while it is
        // solid, fading in step with it, gone once it drops.
        const placed = placedByEvent(events);
        const positions = {}, anims = {};
        Object.keys(state.players).forEach(name => {
            const pos = state.players[name];
            if (!pos) return;
            const gi = placed[name];
            const isShown = gi === undefined || typeof visibility.shown !== 'function' || visibility.shown(gi);
            if (!isShown) return;
            positions[name] = pos;
            const a = (gi !== undefined && typeof visibility.fadeAnimFor === 'function') ? visibility.fadeAnimFor(gi) : '';
            anims[name] = a ? a.replace(/^;animation:/, '') : '';
        });
        fieldRender.applyActorPositions(actorLayerEl, view, positions, {
            players: playerInfo, holder: state.holder, durMs: dur,
        });
        actorLayerEl.querySelectorAll('.fp-actor[data-pname]').forEach(el => { el.style.animation = anims[el.dataset.pname] || ''; });
        moveDisc(state.disc, dur);
        discEl.classList.toggle('opp', state.who === 'opp');
        discEl.classList.toggle('goal', !!state.goal);
        const who = state.who;
        bannerEl.innerHTML = who
            ? `<span class="rv-badge ${who === 'us' ? 'off' : 'def'}">${who === 'us' ? 'Offense' : 'Defense'}</span>`
            : (state.goal ? `<span class="rv-badge goal">Goal</span>` : '');
        return dur;
    }

    // ---- log + hud ----
    function lineEls() { return logEl.querySelectorAll('[data-entry]'); }
    function markLog(index) {
        let cur = null;
        lineEls().forEach(el => {
            const i = +el.dataset.entry;
            el.classList.toggle('rv-cur', i === index);
            el.classList.toggle('rv-future', i > index);
            if (i === index) cur = el;
        });
        if (cur && shown) {
            const top = cur.offsetTop - logEl.offsetTop, bot = top + cur.offsetHeight;
            if (top < logEl.scrollTop) logEl.scrollTop = top - 4;
            else if (bot > logEl.scrollTop + logEl.clientHeight) logEl.scrollTop = bot - logEl.clientHeight + 4;
        }
    }

    // Timeline: one segment per point, width proportional to how long the
    // point took. Untimed points (legacy data) get the median timed duration
    // so they stay visible; a floor keeps very short points tappable.
    let segs = [];   // [{pointIdx, left, width (fractions 0..1), startAt, endAt, first, last, winner, located}]
    function layoutSegments() {
        const sums = engine.pointSummaries();
        const durs = sums.map(s => (s.startAt !== null && s.endAt !== null && s.endAt > s.startAt) ? s.endAt - s.startAt : null);
        const known = durs.filter(d => d !== null).sort((a, b) => a - b);
        const median = known.length ? known[Math.floor(known.length / 2)] : 1;
        const weights = durs.map(d => Math.max(d === null ? median : d, median * 0.25));
        const total = weights.reduce((a, b) => a + b, 0) || 1;
        let x = 0;
        segs = sums.map((s, i) => {
            const w = weights[i] / total;
            const seg = { pointIdx: s.pointIdx, left: x, width: w, startAt: s.startAt, endAt: s.endAt,
                first: s.first, last: s.last, winner: s.winner, located: s.located };
            x += w;
            return seg;
        });
    }
    function renderTimeline() {
        layoutSegments();
        timelineEl.querySelectorAll('.rv-seg').forEach(s => s.remove());
        segs.forEach(s => {
            const el = document.createElement('div');
            el.className = 'rv-seg ' + (s.winner || 'open') + (s.located ? '' : ' unlocated');
            el.style.left = (s.left * 100) + '%';
            el.style.width = (s.width * 100) + '%';
            el.dataset.point = String(s.pointIdx);
            el.innerHTML = `<span class="rv-pn">${s.pointIdx + 1}</span>`;
            timelineEl.appendChild(el);
        });
    }
    function positionHead(index) {
        const pointIdx = engine.pointOf(index);
        const seg = pointIdx !== null ? segs[pointIdx] : null;
        if (!seg) { headEl.style.left = '0%'; return; }
        const entry = engine.entries[index];
        let frac;
        if (entry && entry.at !== null && entry.at !== undefined && seg.startAt !== null && seg.endAt !== null && seg.endAt > seg.startAt) {
            frac = Math.max(0, Math.min(1, (entry.at - seg.startAt) / (seg.endAt - seg.startAt)));
        } else {
            frac = seg.last > seg.first ? (index - seg.first) / (seg.last - seg.first) : 0;
        }
        headEl.style.left = ((seg.left + frac * seg.width) * 100) + '%';
    }
    /** Entry index for a horizontal fraction of the timeline. */
    function entryAtFraction(fx) {
        fx = Math.max(0, Math.min(0.9999, fx));
        const seg = segs.find(s => fx >= s.left && fx < s.left + s.width) || segs[segs.length - 1];
        if (!seg) return 0;
        const f = seg.width > 0 ? (fx - seg.left) / seg.width : 0;
        if (seg.startAt !== null && seg.endAt !== null && seg.endAt > seg.startAt) {
            const t = seg.startAt + f * (seg.endAt - seg.startAt);
            let best = seg.first;
            for (let i = seg.first; i <= seg.last; i++) {
                const a = engine.entries[i].at;
                if (a !== null && a !== undefined && a <= t) best = i;
            }
            return best;
        }
        return seg.first + Math.round(f * (seg.last - seg.first));
    }

    function renderTransport(s) {
        playBtn.innerHTML = s.playing ? ICON.pause : ICON.play;
        playBtn.title = s.playing ? 'Pause' : 'Play';
        prevBtn.disabled = s.index <= 0;
        nextBtn.disabled = s.index >= s.length - 1;
        const pos = SPEED_STOPS.indexOf(s.speed);
        if (pos >= 0 && +speedInput.value !== pos) speedInput.value = String(pos);
        [...ticksEl.children].forEach((el, i) => el.classList.toggle('cur', i === pos));
        root.classList.toggle('rv-following', !!s.follow);
        root.classList.toggle('rv-waiting', !!s.follow && s.atTail);
        goLiveBtn.hidden = !(s.unseen > 0 && !s.follow);
        if (s.unseen > 0) goLiveBtn.textContent = `${s.unseen} new · Go live ›`;
        root.classList.toggle('rv-editing', !!s.editing);
        editBtn.classList.toggle('on', !!s.editing);
        editBtn.title = s.editing ? 'Stop editing' : 'Edit play';
        if (editor) editor.onTransport(s);
        positionHead(s.index);
    }

    controller.on('field', ({ index, state, animate }) => {
        const dur = drawField(index, state, animate);
        markLog(index);
        return dur;
    });
    // The editor subscribes to 'field' too (it re-renders its sheet when the
    // playhead moves), so it is created before the transport listener that
    // hands it snapshots.
    const editor = editable ? createReplayEditor({
        root, fieldEl, view, engine, controller,
        getGame, getEntryOptions,
        getPlayerByName: cfg.getPlayerByName,
        canEdit: cfg.canEdit, editDeniedMessage: cfg.editDeniedMessage, onEdited: cfg.onEdited,
        redraw: () => redraw(),
        refreshView: () => onLogUpdated(),
    }) : null;
    controller.on('transport', renderTransport);

    // ---- wiring ----
    playBtn.addEventListener('click', () => controller.toggle());
    prevBtn.addEventListener('click', () => controller.stepBack());
    nextBtn.addEventListener('click', () => controller.stepForward());
    speedInput.addEventListener('input', () => {
        let pos = +speedInput.value;
        if (pos === 0 && !live) { pos = 1; speedInput.value = '1'; }
        controller.setSpeed(SPEED_STOPS[pos]);
    });
    q('.rv-rotate').addEventListener('click', () => {
        orientation = orientation === 'landscape' ? 'portrait' : 'landscape';
        advancedSettings.set('replay.orientation', orientation);
        stageEl.dataset.o = orientation;
        view.o = orientation;
        redraw();
    });
    goLiveBtn.addEventListener('click', () => controller.goLive());
    editBtn.addEventListener('click', () => { if (editor) editor.toggle(); });

    // Timeline scrubbing: tap or drag. Pointer capture keeps the drag on the
    // bar; touch-action: none (CSS) keeps the page from scrolling instead.
    let scrubbing = false, lastScrubIndex = null;
    const scrubTo = ev => {
        const r = timelineEl.getBoundingClientRect();
        if (!r.width) return;
        const i = entryAtFraction((ev.clientX - r.left) / r.width);
        if (i !== lastScrubIndex) { lastScrubIndex = i; controller.seek(i); }
    };
    timelineEl.addEventListener('pointerdown', ev => {
        scrubbing = true; lastScrubIndex = null;
        try { timelineEl.setPointerCapture(ev.pointerId); } catch (e) { /* not capturable */ }
        controller.pause();
        scrubTo(ev);
        ev.preventDefault();
    });
    timelineEl.addEventListener('pointermove', ev => { if (scrubbing) scrubTo(ev); });
    const endScrub = () => { scrubbing = false; lastScrubIndex = null; };
    timelineEl.addEventListener('pointerup', endScrub);
    timelineEl.addEventListener('pointercancel', endScrub);

    const onLogClick = ev => {
        const line = ev.target.closest('[data-entry]');
        if (!line || !logEl.contains(line)) return;
        controller.pause();
        controller.seek(+line.dataset.entry);
    };
    logEl.addEventListener('click', onLogClick);

    function redraw() {
        const i = controller.index;
        drawField(i, engine.fieldStateAt(i), false);
        markLog(i);
        renderTransport(controller.snapshot());
    }

    // ---- lifecycle ----
    /** The game changed (sync, local event, undo) and the log was re-rendered. */
    function onLogUpdated() {
        controller.refresh(getGame());
        renderTimeline();
        markLog(controller.index);
        if (!controller.state.playing) redraw();
    }
    function onShown() { shown = true; redraw(); }
    function onHidden() {
        shown = false;
        // A replay in progress stops with the tab; live-follow keeps its state
        // (no timers run while waiting) so the tail is current on return.
        if (controller.state.playing && !controller.state.follow) controller.pause();
        if (editor) editor.close();
    }
    function destroy() {
        if (editor) editor.destroy();
        controller.destroy();
        fade.dispose();
        logEl.removeEventListener('click', onLogClick);
        lineEls().forEach(el => el.classList.remove('rv-cur', 'rv-future'));
        root.remove();
    }

    // Initial position: a live game follows the tail (the log reads as it
    // always has, newest line at the bottom); a finished game parks on the
    // last line, paused — Play then replays from the top.
    renderTimeline();
    if (live) controller.goLive();
    else { controller.setSpeed(1); controller.seek(engine.entries.length - 1); }
    renderTransport(controller.snapshot());

    return { refresh: onLogUpdated, onLogUpdated, onShown, onHidden, destroy, controller, engine, root, editor };
}

export { mountReplayView, SPEED_STOPS };
