/*
 * Replay Controller — the clock around replayEngine (docs/replay-viewer-plan.md
 * step 4). Owns the playhead, the play/pause timer, live-follow, and the
 * unseen-events counter; knows nothing about the DOM. Subscribers render.
 *
 * Emits:
 *   'field'      { index, state, animate }   — engine.fieldStateAt(index);
 *                 animate=false on seeks. A listener may RETURN a number: the
 *                 milliseconds its animation will take. The longest return is
 *                 the lastAnimMs the engine paces the next entry against.
 *   'entry'      { index, entry, saidSoFar } — the narration hook. A listener
 *                 may return a Promise; in play-after-play mode the next entry
 *                 waits for every returned promise (capped by holdCeilingMs so
 *                 a stuck TTS never freezes replay). saidSoFar is the text of
 *                 the last few entries played, oldest first, for the
 *                 commentator's prompt (Decision 12).
 *   'transport'  snapshot()                  — whenever playing/speed/follow/
 *                 unseen/index change.
 *
 * Live (Decision 6): speed 'live' means follow the tail. refresh() after a
 * sync rebuilds the engine; new entries animate immediately when following,
 * else they count as unseen until goLive(). Any seek or step-back while
 * following drops to 1×.
 */

const SAID_SO_FAR_MAX = 8;

function createReplayController(engine, deps = {}) {
    const setT = deps.setTimeout || ((fn, ms) => globalThis.setTimeout(fn, ms));
    const clearT = deps.clearTimeout || (id => globalThis.clearTimeout(id));
    const holdCeilingMs = deps.holdCeilingMs || 8000;

    const S = { index: -1, playing: false, speed: 1, follow: false, unseen: 0, editing: false };
    const listeners = { field: [], entry: [], transport: [] };
    let timer = null;
    let lastAnimMs = 0;
    let seq = 0;               // invalidates in-flight holds/timers
    const saidSoFar = [];

    function on(type, fn) { listeners[type].push(fn); return () => off(type, fn); }
    function off(type, fn) { const l = listeners[type]; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
    function emit(type, payload) { return listeners[type].map(fn => { try { return fn(payload); } catch (e) { return undefined; } }); }

    function snapshot() {
        return { index: S.index, playing: S.playing, speed: S.speed, follow: S.follow, unseen: S.unseen,
            editing: S.editing, length: engine.entries.length, atTail: S.index >= engine.entries.length - 1 };
    }
    function transport() { emit('transport', snapshot()); }

    function cancelTimer() { if (timer !== null) { clearT(timer); timer = null; } seq++; }

    /** Move the playhead to i and tell renderers. Returns the narration holds. */
    function fire(i, animate) {
        S.index = i;
        const entry = engine.entries[i] || null;
        const state = engine.fieldStateAt(i);
        const anims = emit('field', { index: i, state, animate })
            .filter(v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
        lastAnimMs = animate ? (anims.length ? Math.max(...anims) : 0) : 0;
        let holds = [];
        if (entry && animate) {
            const said = saidSoFar.slice();
            holds = emit('entry', { index: i, entry, saidSoFar: said })
                .filter(v => v && typeof v.then === 'function');
            if (entry.text && entry.text.trim()) {
                saidSoFar.push(entry.text);
                while (saidSoFar.length > SAID_SO_FAR_MAX) saidSoFar.shift();
            }
        }
        return holds;
    }

    function scheduleNext(holds = []) {
        cancelTimer();
        if (!S.playing) return;
        const mySeq = seq;
        const next = S.index + 1;
        if (next >= engine.entries.length) {
            if (!S.follow) { S.playing = false; transport(); }
            return;   // following: stay armed; refresh() resumes when the tail grows
        }
        const arm = () => {
            if (mySeq !== seq || !S.playing) return;
            const delay = engine.delayBefore(next, lastAnimMs);
            timer = setT(() => { timer = null; if (mySeq !== seq) return; step(); }, delay);
        };
        if (S.speed === 'pap' && holds.length) {
            let done = false;
            const finish = () => { if (done) return; done = true; clearT(ceiling); arm(); };
            const ceiling = setT(finish, holdCeilingMs);
            Promise.all(holds).then(finish, finish);
        } else {
            arm();
        }
    }

    function step() {
        const next = S.index + 1;
        if (next >= engine.entries.length) { scheduleNext(); return; }
        const holds = fire(next, true);
        transport();
        scheduleNext(holds);
    }

    function play() {
        if (S.playing) return;
        S.editing = false;
        if (S.index >= engine.entries.length - 1 && !S.follow) {
            // Replaying from the end restarts from the top.
            S.index = -1;
            fire(-1, false);
        }
        S.playing = true;
        transport();
        scheduleNext();
    }

    function pause() {
        cancelTimer();
        if (!S.playing) { transport(); return; }
        S.playing = false;
        transport();
    }

    function toggle() { if (S.playing) pause(); else play(); }

    function dropFollow() {
        if (!S.follow) return;
        S.follow = false;
        S.speed = 1;
        engine.setOptions({ speed: 1 });
    }

    /** Jump the playhead (no animation). Keeps playing if it was. */
    function seek(i) {
        const max = engine.entries.length - 1;
        i = Math.max(-1, Math.min(max, i));
        cancelTimer();
        if (i < max) dropFollow();
        fire(i, false);
        transport();
        if (S.playing) scheduleNext();
    }

    /** Advance one entry with animation; pauses playback. */
    function stepForward() {
        cancelTimer();
        S.playing = false;
        if (S.index >= engine.entries.length - 1) { transport(); return; }
        dropFollow();
        fire(S.index + 1, true);
        transport();
    }

    /** Back one entry (no animation); pauses playback. */
    function stepBack() {
        cancelTimer();
        S.playing = false;
        dropFollow();
        fire(Math.max(-1, S.index - 1), false);
        transport();
    }

    function setSpeed(speed) {
        if (speed === 'live') { goLive(); return; }
        S.speed = speed;
        S.follow = false;
        engine.setOptions({ speed });
        transport();
        if (S.playing) scheduleNext();
    }

    /** Follow the tail: jump to the newest entry and keep playing as it grows. */
    function goLive() {
        cancelTimer();
        S.speed = 'live';
        S.follow = true;
        S.unseen = 0;
        S.editing = false;
        engine.setOptions({ speed: 'live' });
        fire(engine.entries.length - 1, false);
        S.playing = true;
        transport();
        scheduleNext();
    }

    /**
     * Call after the game changed (sync refresh, local event, undo). Rebuilds
     * the engine; following → new entries play now, else they count as unseen.
     */
    function refresh(game) {
        const oldLen = engine.entries.length;
        engine.rebuild(game);
        const newLen = engine.entries.length;
        if (S.index >= newLen) {
            // Entries behind the playhead were removed (undo): clamp.
            cancelTimer();
            fire(newLen - 1, false);
        }
        if (newLen > oldLen) {
            if (S.follow) {
                if (!S.playing) S.playing = true;
                scheduleNext();
            } else {
                S.unseen += newLen - oldLen;
            }
        } else if (newLen < oldLen && S.follow) {
            S.index = Math.min(S.index, newLen - 1);
        }
        transport();
    }

    function setEditing(on) {
        if (on && S.playing) return false;
        S.editing = !!on;
        transport();
        return S.editing;
    }

    function destroy() { cancelTimer(); S.playing = false; Object.keys(listeners).forEach(k => { listeners[k].length = 0; }); }

    return {
        on, off, snapshot,
        play, pause, toggle, seek, stepForward, stepBack, setSpeed, goLive, refresh, setEditing, destroy,
        get index() { return S.index; },
        get state() { return S; },
    };
}

export { createReplayController };
