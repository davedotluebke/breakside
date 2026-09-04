/*
 * Replay Engine — the pure core of the replay viewer (docs/replay-viewer-plan.md
 * step 3). Given a game it exposes:
 *
 *   - entries        the game log as GameLogEntry[] (utils/gameLogRenderer.js)
 *                    — the replay's scrub axis; one line of the Log tab = one
 *                    entry = one playhead position
 *   - fieldStateAt(i)  what the pitch should show once entry i has played:
 *                    who is where, where the disc is, arrows/spots, holder
 *   - delayBefore(i, lastAnimMs)  how long to wait before firing entry i
 *   - hasLocations(pointIdx) / pointSummaries()  for the collapse rule and
 *                    the point-timeline scrubber
 *
 * No timers, no DOM, no globals: playByPlay/replayController.js owns the
 * clock. Takes a plain game-shaped object (deserialized Game or raw JSON
 * with summarize-capable events) so the same code can later ship to the
 * public share viewer.
 *
 * Pacing rule (Decision 1, 5, 7, 8 in the plan):
 *   live               → lastAnimMs                (the real gap already elapsed)
 *   pap (play after play) or either neighbour untimed
 *                      → lastAnimMs + papHoldMs    (never synthesize timing)
 *   otherwise          → max(min(Δat, cap) / speed, lastAnimMs)
 *   where cap = capBetweenMs before a 'roster' entry (a new point) else
 *   capWithinMs, and cap 0 = Off (no clipping).
 *
 * Field-state rule (Decision 2): only events place players. A Throw puts the
 * thrower at `from` and the receiver at `to`; a Turnover puts the thrower at
 * `from` and the disc at `to` in opponent hands; a Defense puts the defender
 * at `to`; a Pull puts the puller at `from` and the disc at `to`. A 'roster'
 * entry resets everyone to the strip. Events without locations move nobody.
 */
import { buildGameLogEntries } from '../utils/gameLogRenderer.js';

const DEFAULTS = Object.freeze({
    capWithinMs: 4000,     // dead time between plays within a point (0 = Off)
    capBetweenMs: 8000,    // dead time between points (0 = Off)
    speed: 1,              // 1 | 2 | 4 | 'pap' | 'live'
    papHoldMs: 600,        // breathing room after an animation in play-after-play
});

const ENTRY_OPTION_KEYS = ['teamName', 'opponentName', 'versionInfo', 'rosterNames', 'scoreBadge', 'resolvePlayerName'];

const nameOf = ref => (ref && typeof ref === 'object' && ref.name) ? ref.name
    : (typeof ref === 'string' ? ref : null);
const hasLoc = loc => !!(loc && typeof loc.x === 'number' && typeof loc.y === 'number');
const copyLoc = loc => hasLoc(loc) ? { x: loc.x, y: loc.y } : null;

/**
 * @param {object} game - game-shaped object
 * @param {object} [options] - DEFAULTS keys plus the buildGameLogEntries
 *   options (teamName, opponentName, versionInfo, rosterNames, scoreBadge,
 *   resolvePlayerName)
 */
function createReplayEngine(game, options = {}) {
    let opts = Object.assign({}, DEFAULTS, options);
    let entries = [];
    let pointRanges = [];   // pointIdx → { first, last } entry indices

    function entryOptions() {
        const o = {};
        ENTRY_OPTION_KEYS.forEach(k => { if (opts[k] !== undefined) o[k] = opts[k]; });
        return o;
    }

    /** Recompute entries (after a sync refresh, an undo, a local event). */
    function rebuild(nextGame) {
        if (nextGame) game = nextGame;
        entries = buildGameLogEntries(game, entryOptions());
        pointRanges = [];
        entries.forEach((e, i) => {
            if (e.pointIdx === null || e.pointIdx === undefined) return;
            const r = pointRanges[e.pointIdx] || (pointRanges[e.pointIdx] = { first: i, last: i });
            r.last = i;
        });
        return entries;
    }

    function setOptions(patch) {
        const before = entryOptions();
        opts = Object.assign({}, opts, patch);
        const after = entryOptions();
        if (JSON.stringify(Object.keys(before)) !== JSON.stringify(Object.keys(after))
            || ENTRY_OPTION_KEYS.some(k => before[k] !== after[k])) {
            rebuild();
        }
    }

    function pointOf(i) {
        const e = entries[i];
        return (e && e.pointIdx !== null && e.pointIdx !== undefined) ? e.pointIdx : null;
    }

    function pointRange(pointIdx) {
        const r = pointRanges[pointIdx];
        return r ? { first: r.first, last: r.last } : null;
    }

    function pointEvents(pointIdx) {
        const point = (game && game.points) ? game.points[pointIdx] : null;
        const out = [];
        if (!point) return out;
        (point.possessions || []).forEach(poss => (poss.events || []).forEach(e => out.push(e)));
        return out;
    }

    /** True when any event in the point has a field location. */
    function hasLocations(pointIdx) {
        return pointEvents(pointIdx).some(e => hasLoc(e.to) || hasLoc(e.from));
    }

    /** True when any event in the whole game has a field location. */
    function gameHasLocations() {
        return ((game && game.points) || []).some((_, i) => hasLocations(i));
    }

    function isFinished() {
        return !!(game && game.gameEndTimestamp);
    }

    function rosterNames(pointIdx) {
        const point = (game && game.points) ? game.points[pointIdx] : null;
        const raw = (point && point.players) || [];
        return raw.map(p => (opts.resolvePlayerName ? opts.resolvePlayerName(p) : p)).map(String);
    }

    /**
     * The pitch after entry `upto` has played. Walks from the point's roster
     * entry (O(events in the point)).
     * @returns {{pointIdx:number|null, roster:string[], players:Object<string,{x,y}|null>,
     *   disc:{x,y}|null, who:'us'|'opp'|null, holder:string|null,
     *   arrows:{a:{x,y},b:{x,y},kind:string,poss:number}[], spots:{p:{x,y},kind:string}[],
     *   goal:boolean, possSeq:number}}
     */
    function fieldStateAt(upto) {
        const st = { pointIdx: null, roster: [], players: {}, disc: null, who: null, holder: null,
            arrows: [], spots: [], goal: false, possSeq: 0 };
        const pointIdx = pointOf(upto);
        if (pointIdx === null) return st;
        const range = pointRanges[pointIdx];
        st.pointIdx = pointIdx;
        st.roster = rosterNames(pointIdx);
        st.roster.forEach(n => { st.players[n] = null; });
        const place = (ref, loc) => {
            const n = nameOf(ref);
            if (n && hasLoc(loc)) st.players[n] = copyLoc(loc);
            return n;
        };
        for (let i = range.first; i <= upto && i < entries.length; i++) {
            const f = entries[i];
            if (f.pointIdx !== pointIdx) continue;
            if (f.kind === 'possession') { st.who = f.side; st.possSeq++; }
            else if (f.kind === 'score') { st.who = null; st.goal = f.side === 'us'; }
            else if (f.kind === 'event') {
                const e = f.event;
                if (!e) continue;
                if (e.type === 'Throw') {
                    place(e.thrower, e.from);
                    st.holder = place(e.receiver, e.to);
                    if (hasLoc(e.from) && hasLoc(e.to)) {
                        st.arrows.push({ a: copyLoc(e.from), b: copyLoc(e.to), kind: e.score_flag ? 'score' : 'throw', poss: st.possSeq });
                    }
                    if (hasLoc(e.to)) st.disc = copyLoc(e.to);
                } else if (e.type === 'Turnover') {
                    place(e.thrower, e.from);
                    st.holder = null;
                    if (hasLoc(e.from) && hasLoc(e.to)) {
                        st.arrows.push({ a: copyLoc(e.from), b: copyLoc(e.to), kind: 'turn', poss: st.possSeq });
                    }
                    if (hasLoc(e.to)) st.disc = copyLoc(e.to);
                } else if (e.type === 'Defense') {
                    const d = place(e.defender, e.to);
                    st.holder = (e.interception_flag && d) ? d : null;
                    if (hasLoc(e.to)) { st.disc = copyLoc(e.to); st.spots.push({ p: copyLoc(e.to), kind: 'block' }); }
                } else if (e.type === 'Pull') {
                    place(e.puller, e.from);
                    st.holder = null;
                    if (hasLoc(e.from) && hasLoc(e.to)) {
                        st.arrows.push({ a: copyLoc(e.from), b: copyLoc(e.to), kind: 'pull', poss: st.possSeq });
                    }
                    if (hasLoc(e.to)) st.disc = copyLoc(e.to);
                }
            }
        }
        return st;
    }

    /**
     * Milliseconds to wait before firing entry i, given the previous entry
     * fired just now and its animation runs lastAnimMs. See the file header.
     */
    function delayBefore(i, lastAnimMs = 0) {
        const anim = Math.max(0, lastAnimMs || 0);
        const entry = entries[i];
        const prev = entries[i - 1];
        if (!entry) return anim;
        if (opts.speed === 'live') return anim;
        const untimed = !prev || entry.at === null || entry.at === undefined || prev.at === null || prev.at === undefined;
        if (opts.speed === 'pap' || untimed) return anim + opts.papHoldMs;
        let gap = Math.max(0, entry.at - prev.at);
        const cap = entry.kind === 'roster' ? opts.capBetweenMs : opts.capWithinMs;
        if (cap > 0) gap = Math.min(gap, cap);
        const speed = (typeof opts.speed === 'number' && opts.speed > 0) ? opts.speed : 1;
        return Math.max(gap / speed, anim);
    }

    /** Per-point summary for the timeline scrubber. */
    function pointSummaries() {
        return ((game && game.points) || []).map((point, pointIdx) => {
            const r = pointRanges[pointIdx] || null;
            let startAt = null, endAt = null;
            if (r) {
                for (let i = r.first; i <= r.last; i++) {
                    const a = entries[i].at;
                    if (a !== null && a !== undefined) { if (startAt === null) startAt = a; endAt = a; }
                }
            }
            return {
                pointIdx, first: r ? r.first : null, last: r ? r.last : null,
                startAt, endAt,
                winner: point.winner === 'team' ? 'us' : (point.winner === 'opponent' ? 'opp' : null),
                located: hasLocations(pointIdx),
            };
        });
    }

    rebuild();

    return {
        get entries() { return entries; },
        get game() { return game; },
        get options() { return opts; },
        rebuild, setOptions, pointOf, pointRange, pointSummaries,
        hasLocations, gameHasLocations, isFinished,
        fieldStateAt, delayBefore,
    };
}

export { createReplayEngine, DEFAULTS as REPLAY_DEFAULTS };
