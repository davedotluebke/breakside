/*
 * Replay View — the Log tab's field playback (docs/replay-viewer-plan.md
 * step 6) and, mounted with a finished game, the post-game summary's.
 *
 * Composition: a STAGE (lineup strip + the Field tab's pitch, drawn by
 * playByPlay/fieldRender.js) above a TRANSPORT bar (⏮ ▶ ⏭ · slider Live · 1×
 * · 2× · 4× · Play after play · ⟳ rotate) above a point TIMELINE, all sitting
 * on top of the existing game-log lines. The log itself is untouched: lines
 * come from renderGameLogEntriesHTML (each carries data-entry), and this
 * module only adds rv-cur / rv-future classes and a tap-to-seek handler.
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
import { advancedSettings } from '../settings/advancedSettings.js';

const SPEED_STOPS = ['live', 1, 2, 4, 'pap'];
const SPEED_LABELS = ['Live', '1×', '2×', '4×', 'Play after play'];

/**
 * Mount a replay view.
 * @param {object} cfg
 * @param {HTMLElement} cfg.host - element the stage/transport/timeline are inserted into (prepended)
 * @param {HTMLElement} cfg.logEl - the element holding the rendered game-log lines (data-entry divs)
 * @param {() => object} cfg.getGame - returns the current game object (re-read on every refresh)
 * @param {() => object} cfg.getEntryOptions - the buildGameLogEntries options the LOG was rendered
 *   with (teamName/opponentName/versionInfo/rosterNames/resolvePlayerName) — the engine must build
 *   the same entry list so indices line up with the log's data-entry attributes
 * @param {boolean} [cfg.live] - offer Live (follow the tail); false for finished games
 * @returns {{refresh:Function, onLogUpdated:Function, onShown:Function, onHidden:Function, destroy:Function, controller:object, engine:object}|null}
 *   null when the game has no located events (nothing mounted)
 */
function mountReplayView(cfg) {
    const { host, logEl, getGame, getEntryOptions } = cfg;
    if (!host || !logEl) return null;
    const settings = advancedSettings.getReplaySettings();
    const engine = createReplayEngine(getGame(), Object.assign({
        capWithinMs: settings.capWithinMs, capBetweenMs: settings.capBetweenMs,
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
            <div class="rv-strip"></div>
            <div class="rv-fieldwrap"><div class="rv-possbanner"></div><div class="fp-field rv-field"></div></div>
        </div>
        <div class="rv-nofield">No field positions were recorded for this point</div>
        <div class="rv-transport">
            <button class="rv-tbtn rv-prev" title="Previous play" aria-label="Previous play"><i class="fas fa-step-backward"></i></button>
            <button class="rv-tbtn rv-play" title="Play" aria-label="Play"><i class="fas fa-play"></i></button>
            <button class="rv-tbtn rv-next" title="Next play" aria-label="Next play"><i class="fas fa-step-forward"></i></button>
            <div class="rv-speed">
                <input type="range" class="rv-speed-input" min="0" max="4" step="1" value="1" aria-label="Playback speed">
                <div class="rv-ticks">${SPEED_LABELS.map(l => `<span>${l}</span>`).join('')}</div>
            </div>
            <button class="rv-tbtn rv-rotate" title="Rotate field" aria-label="Rotate field"><i class="fas fa-sync-alt"></i></button>
        </div>
        <div class="rv-timeline" title="Points — tap to jump"><div class="rv-head"></div></div>
        <button class="rv-golive" hidden></button>
    `;
    host.insertBefore(root, host.firstChild);
    const q = sel => root.querySelector(sel);
    const stageEl = q('.rv-stage'), stripEl = q('.rv-strip'), fieldEl = q('.rv-field'), bannerEl = q('.rv-possbanner');
    const playBtn = q('.rv-play'), prevBtn = q('.rv-prev'), nextBtn = q('.rv-next');
    const speedInput = q('.rv-speed-input'), ticksEl = q('.rv-ticks');
    const timelineEl = q('.rv-timeline'), headEl = q('.rv-head'), goLiveBtn = q('.rv-golive');
    if (!live) { ticksEl.firstElementChild.classList.add('disabled'); }

    // ---- field adapter (playByPlay/fieldRender.js) ----
    // The pitch is the Field tab's: static layers + the located-event layer
    // (arrows / markers, with the same fade-out of demoted plays) come from
    // fieldRender; on top sit the actor layer (player icons at reconstructed
    // positions) and our own persistent disc element, both moved in place so
    // CSS transitions carry the motion. The event layer's own disc is hidden
    // by replayView.css — a rebuilt element can't animate.
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

    /** Animation length for the move that entry `index` causes, ms. */
    function animMs(index, animate) {
        if (!animate) return 0;
        const e = engine.entries[index];
        if (!e || e.kind !== 'event' || !e.event) return 0;
        const ev = e.event;
        const speed = typeof controller.state.speed === 'number' ? controller.state.speed : 1;
        if (ev.type === 'Pull') return Math.min(typeof ev.hang === 'number' && ev.hang > 0 ? ev.hang : 1500, 2500) / speed;
        if (!ev.to) return 0;
        if (!ev.from) return 450 / speed;
        const d = Math.hypot(ev.to.x - ev.from.x, (ev.to.y - ev.from.y) * 0.57);
        return Math.max(350, Math.min(1100, d * 1400)) / speed;
    }

    // ---- strip fitting: one line, compacting as needed ----
    // Levels, tried in order until the row fits: full (number + name), name
    // only, number + initials, initials only. Portrait stacks chips in a
    // column and never compacts.
    const initialsOf = name => {
        const words = String(name).trim().split(/\s+/).filter(Boolean);
        if (words.length >= 2) return words.map(w => w[0].toUpperCase()).join('');
        return String(name).slice(0, 2);
    };
    let fitKey = null, fitLevel = 0;
    function applyLevel(level) {
        stripEl.classList.toggle('rv-compact', level >= 2);
        stripEl.querySelectorAll('.fp-chip[data-pname]').forEach(el => {
            const name = el.dataset.pname;
            const num = el.querySelector('.fp-num');
            const nm = el.querySelector('.fp-nm');
            if (num) num.hidden = (level === 1 || level === 3);
            if (nm) nm.textContent = level >= 2 ? initialsOf(name) : name;
        });
    }
    function fitStrip() {
        if (view.o !== 'landscape') { applyLevel(0); fitKey = null; return; }
        const key = stripEl.clientWidth + '|' + Array.from(stripEl.querySelectorAll('.fp-chip')).map(c => c.dataset.pname).join(',');
        if (key === fitKey) { applyLevel(fitLevel); return; }
        for (let level = 0; level <= 3; level++) {
            applyLevel(level);
            fitLevel = level;
            if (stripEl.scrollWidth <= stripEl.clientWidth + 1) break;
        }
        fitKey = key;
    }
    const stripRO = (typeof ResizeObserver === 'function') ? new ResizeObserver(() => { fitKey = null; fitStrip(); }) : null;
    if (stripRO) stripRO.observe(stripEl);

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
        eventLayerEl.innerHTML = fieldRender.eventLayerHTML(view, {
            events, mode,
            pointKey: fieldRender.stablePointKey(engine.game, point),
            discLoc: state.disc, fade,
        });
        fieldRender.applyActorPositions(actorLayerEl, view, state.players, {
            players: playerInfo, holder: state.holder, durMs: dur,
        });
        moveDisc(state.disc, dur);
        discEl.classList.toggle('opp', state.who === 'opp');
        discEl.classList.toggle('goal', !!state.goal);
        // Strip: the whole line; a chip lights up once the player is on the field.
        stripEl.innerHTML = state.roster.map(name => fieldRender.chipHTML(playerInfo(name), { holder: state.holder === name })).join('');
        stripEl.querySelectorAll('.fp-chip[data-pname]').forEach(el => el.classList.toggle('on-field', !!state.players[el.dataset.pname]));
        fitStrip();
        const who = state.who;
        bannerEl.innerHTML = who
            ? `<span class="rv-badge ${who}">${who === 'us' ? (engine.options.teamName || 'Us') : (engine.options.opponentName || 'Opponent')} possession</span>`
            : (state.goal ? `<span class="rv-badge us">Goal</span>` : '');
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
    function renderTimeline() {
        timelineEl.querySelectorAll('.rv-seg').forEach(s => s.remove());
        const sums = engine.pointSummaries();
        const n = sums.length;
        if (!n) return;
        // Equal-width segments: point durations are unknown for legacy data
        // and a duration-proportional bar would misrepresent mixed games.
        sums.forEach((s, i) => {
            const seg = document.createElement('div');
            seg.className = 'rv-seg ' + (s.winner || 'open') + (s.located ? '' : ' unlocated');
            seg.style.left = (i / n * 100) + '%';
            seg.style.width = (100 / n) + '%';
            seg.dataset.point = String(s.pointIdx);
            seg.innerHTML = `<span class="rv-pn">${s.pointIdx + 1}</span>`;
            timelineEl.appendChild(seg);
        });
    }
    function positionHead(index) {
        const pointIdx = engine.pointOf(index);
        const n = engine.pointSummaries().length;
        if (pointIdx === null || !n) { headEl.style.left = '0%'; return; }
        const r = engine.pointRange(pointIdx);
        const frac = r.last > r.first ? (index - r.first) / (r.last - r.first) : 0;
        headEl.style.left = ((pointIdx + frac) / n * 100) + '%';
    }
    function renderTransport(s) {
        playBtn.innerHTML = s.playing ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
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
        positionHead(s.index);
    }

    controller.on('field', ({ index, state, animate }) => {
        const dur = drawField(index, state, animate);
        markLog(index);
        return dur;
    });
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
    timelineEl.addEventListener('click', ev => {
        const seg = ev.target.closest('.rv-seg');
        if (!seg) return;
        const r = engine.pointRange(+seg.dataset.point);
        if (r) { controller.pause(); controller.seek(r.first); }
    });
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
    }
    function destroy() {
        controller.destroy();
        fade.dispose();
        if (stripRO) stripRO.disconnect();
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

    return { refresh: onLogUpdated, onLogUpdated, onShown, onHidden, destroy, controller, engine, root };
}

export { mountReplayView, SPEED_STOPS };
