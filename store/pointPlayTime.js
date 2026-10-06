/*
 * Who was on the field for how much of a point — pure leaf module (no
 * imports; pattern: store/pointClock.js) shared by the live Select Line
 * time cells (utils/helpers.js getPlayerGameTime), the per-player live
 * counters (game/pointStats.js) and the Review / export accumulator
 * (utils/statAccumulator.js), and pinned by tests/unit/pointPlayTime.test.mjs.
 *
 * A point's play clock (`totalPointTime`, plus the running segment while
 * the point is live) is shared by everyone on the line — until an injury
 * sub changes the line mid-point. The sub event records the play clock at
 * the moment it was recorded (`playTimeAtSub`, written by
 * confirmSubstitution once the clock has stopped for the sub, so it is the
 * play time up to the stoppage) and the line before it (`playersBefore`,
 * the snapshot undo restores). The point therefore splits into segments,
 * each with its own line: a player who went out is credited up to the sub,
 * a player who came in from the sub on. Stoppage time is never on the play
 * clock (ARCHITECTURE.md § Point clock → Stoppages), so the sub's own
 * stoppage counts for nobody.
 *
 * Sub events recorded before `playTimeAtSub` existed (or without a roster
 * snapshot) cannot be placed on the clock. Such a point is one segment
 * whose line is everyone who was on it at any moment (point.players ∪
 * substitutedOutPlayers), each credited in full — the rule the live
 * counters always used.
 *
 * Lines are stored as name-or-id strings frozen when the point was played
 * (ARCHITECTURE.md § point.players entries); callers pass an `onList`
 * predicate that knows how to match their player against such a list
 * (buildPointMembership(game).onList, or the stats resolver).
 */

/** The injury-sub events of a point, in record order. */
export function subEventsOf(point) {
    const subs = [];
    (point?.possessions || []).forEach(poss => (poss.events || []).forEach(e => {
        if (e && e.type === 'Other' && e.injury_flag) subs.push(e);
    }));
    return subs;
}

function placeable(sub) {
    return typeof sub.playTimeAtSub === 'number' && Number.isFinite(sub.playTimeAtSub) &&
        Array.isArray(sub.playersBefore);
}

/**
 * The point's play clock split by its subs.
 * @param {object} point
 * @param {number} totalMs - the point's play time: totalPointTime for a
 *   concluded point, banked plus the running segment for a live one
 * @returns {Array<{from:number,to:number,players:string[]}>|null} segments
 *   in ms of play time covering [0, totalMs], in order; null when a sub
 *   cannot be placed (legacy data — see the file header)
 */
export function rosterSegments(point, totalMs) {
    if (!point) return null;
    const total = Math.max(0, Number(totalMs) || 0);
    const subs = subEventsOf(point);
    if (subs.some(s => !placeable(s))) return null;
    // Record order is play-clock order; clamp defensively so a sub recorded
    // with an odd value can never produce a negative segment.
    const segments = [];
    let from = 0;
    subs.forEach(sub => {
        const at = Math.min(total, Math.max(from, sub.playTimeAtSub));
        segments.push({ from, to: at, players: sub.playersBefore });
        from = at;
    });
    segments.push({ from, to: total, players: point.players || [] });
    return segments;
}

/**
 * Everyone who was on the field at any moment of the point, as the stored
 * entries (deduplicated as strings; callers resolving to ids should
 * deduplicate again).
 */
export function everyoneOn(point) {
    if (!point) return [];
    const segments = rosterSegments(point, 0);
    const lists = segments
        ? segments.map(s => s.players)
        : [point.players || [], point.substitutedOutPlayers || []];
    const seen = new Set();
    const out = [];
    lists.forEach(list => list.forEach(entry => {
        if (!seen.has(entry)) { seen.add(entry); out.push(entry); }
    }));
    return out;
}

/**
 * Play time credited to one player for the point.
 * @param {object} point
 * @param {number} totalMs - as for rosterSegments
 * @param {function(string[]): boolean} onList - whether the player is on a
 *   stored line
 * @returns {number} ms
 */
export function playTimeFor(point, totalMs, onList) {
    if (!point || typeof onList !== 'function') return 0;
    const total = Math.max(0, Number(totalMs) || 0);
    const segments = rosterSegments(point, total);
    if (!segments) {
        const played = onList(point.players || []) || onList(point.substitutedOutPlayers || []);
        return played ? total : 0;
    }
    return segments.reduce((sum, seg) => sum + (onList(seg.players) ? seg.to - seg.from : 0), 0);
}
