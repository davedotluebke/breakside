/*
 * Event amendment — the pure rules for editing a recorded play in place
 * (docs/replay-viewer-plan.md step 8). Shared by the replay editor
 * (playByPlay/replayEdit.js), the Full tab's modifier strip and the Field
 * tab's marker drag, through pbpPossession.amendEvent — the one chokepoint
 * that persists, syncs and publishes.
 *
 * Nothing here touches the DOM, globals or storage: it mutates the event
 * objects it is handed and reports what changed, so node:test can pin the
 * rules (tests/unit/eventAmend.test.mjs). The Throw class is imported only
 * to build the two inferred passes of an Unknown-Player bridge.
 *
 * Rules that live here:
 *   - the modifier tables (which flags each event type exposes for editing)
 *   - throw geometry → huck / reset / swing flags (Field-mode classification)
 *   - the catch-spot cascade: a Throw's `to` is the next event's `from`
 *   - the throw chain, both ways: a receiver whose next throw has a
 *     different thrower, or a thrower whom the previous play didn't leave
 *     the disc with, is a contradiction the caller must resolve — retarget
 *     the neighbour, or bridge with two Unknown Player passes
 *   - live per-player counters (completedPasses / goals / assists) follow a
 *     thrower / receiver change, so the roster stats stay consistent with
 *     what createThrow incremented
 */
import { Throw } from '../store/models.js';

// -----------------------------------------------------------------
// Modifier tables. Keys are the visible chip label; values are the
// property on the event object. Order = display order, most-frequent
// first so common modifiers lead a horizontally scrolling row.
// -----------------------------------------------------------------
export const THROW_MODIFIERS = Object.freeze([
    { label: 'break',        prop: 'break_flag'  },
    { label: 'huck',         prop: 'huck_flag'   },
    { label: 'reset',        prop: 'reset_flag'  },  // legacy stored dump_flag is aliased at deserialize
    { label: 'swing',        prop: 'swing_flag'  },  // auto-set by Field mode geometry; editable anywhere
    { label: 'hammer',       prop: 'hammer_flag' },
    { label: 'sky catch',    prop: 'sky_flag'    },
    { label: 'layout catch', prop: 'layout_flag' },
]);
export const TURNOVER_MODIFIERS = Object.freeze([
    { label: 'huck',   prop: 'huck_flag'    },
    { label: 'good D', prop: 'defense_flag' },
]);
export const DEFENSE_MODIFIERS = Object.freeze([
    { label: 'sky',    prop: 'sky_flag'    },
    { label: 'layout', prop: 'layout_flag' },
]);

/** The editable modifier flags for an event, or [] for types without any. */
export function modifiersFor(event) {
    if (!event) return [];
    if (event.type === 'Throw') return THROW_MODIFIERS;
    if (event.type === 'Turnover') return TURNOVER_MODIFIERS;
    if (event.type === 'Defense') return DEFENSE_MODIFIERS;
    return [];
}

// -----------------------------------------------------------------
// Geometry → flags. Coordinates are the stored normalized frame
// (x along the field, 0 = own goal line, 1 = attacking; y across, 0..1).
// -----------------------------------------------------------------
export const RESET_TOLERANCE = 0.025;   // ~1.75 yd backwards on a 70 yd playing field
export const DEFAULT_FRACTIONS = Object.freeze({ huckFraction: 0.5, swingFraction: 0.25 });

/**
 * Classify a throw by its endpoints: huck (long gain), reset (backwards),
 * swing (lateral, not a huck). Returns {} when either endpoint is missing.
 * `fractions` are the Advanced Settings thresholds (field.huckFraction /
 * field.swingFraction); undefined entries fall back to the defaults.
 */
export function classifyThrowGeometry(from, to, fractions) {
    if (!from || !to || typeof from.x !== 'number' || typeof to.x !== 'number') return {};
    const f = Object.assign({}, DEFAULT_FRACTIONS, fractions || {});
    const dx = to.x - from.x;
    const huck = dx >= f.huckFraction;
    const reset = dx <= -RESET_TOLERANCE;
    const swing = !huck && typeof from.y === 'number' && typeof to.y === 'number'
        && Math.abs(to.y - from.y) >= f.swingFraction;
    return { huck, reset, swing };
}

/**
 * Overwrite exactly the three geometry flags of a located Throw from its
 * endpoints — same rule as at commit time; other flags (break, hammer, sky,
 * layout) are untouched. Returns true when a flag changed.
 */
export function reclassifyThrow(ev, fractions) {
    if (!ev || ev.type !== 'Throw' || !ev.from || !ev.to) return false;
    const c = classifyThrowGeometry(ev.from, ev.to, fractions);
    const before = [ev.huck_flag, ev.reset_flag, ev.swing_flag];
    ev.huck_flag = !!c.huck;
    ev.reset_flag = !!c.reset;
    ev.swing_flag = !!c.swing;
    return before[0] !== ev.huck_flag || before[1] !== ev.reset_flag || before[2] !== ev.swing_flag;
}

// -----------------------------------------------------------------
// Locating events in a point.
// -----------------------------------------------------------------
export const nameOf = ref => (ref && typeof ref === 'object' && ref.name) ? ref.name
    : (typeof ref === 'string' ? ref : null);
const hasLoc = loc => !!(loc && typeof loc.x === 'number' && typeof loc.y === 'number');
const copyLoc = loc => hasLoc(loc) ? { x: loc.x, y: loc.y } : null;

/** All of a point's events in order: [{ event, possIdx, eventIdx }]. */
export function flattenPointEvents(point) {
    const out = [];
    ((point && point.possessions) || []).forEach((poss, possIdx) => {
        (poss.events || []).forEach((event, eventIdx) => out.push({ event, possIdx, eventIdx }));
    });
    return out;
}

/** Position of `event` in its point: { flatIdx, possIdx, eventIdx } or null. */
export function locateEvent(point, event) {
    const flat = flattenPointEvents(point);
    const flatIdx = flat.findIndex(f => f.event === event);
    return flatIdx < 0 ? null : Object.assign({ flatIdx }, flat[flatIdx]);
}

/** The point holding `event`, searching the game: { point, pointIdx } or null. */
export function pointOfEvent(game, event) {
    const points = (game && game.points) || [];
    for (let pointIdx = 0; pointIdx < points.length; pointIdx++) {
        if (locateEvent(points[pointIdx], event)) return { point: points[pointIdx], pointIdx };
    }
    return null;
}

/**
 * The event that follows `event` within the same possession (the throw
 * chain never crosses a possession boundary), or null.
 */
export function nextInPossession(point, event) {
    const at = locateEvent(point, event);
    if (!at) return null;
    const events = point.possessions[at.possIdx].events || [];
    return events[at.eventIdx + 1] || null;
}

/**
 * Would giving `event` (a Throw) the receiver `newReceiver` contradict the
 * next play? The next Throw / Turnover in the possession is thrown by
 * whoever caught this one; if that thrower is someone else the caller must
 * choose how to reconcile (see pbpPossession.amendEvent's `chain` option).
 * @returns {{ next: object, thrower: string }|null} the conflicting next
 *   event and its thrower's name, or null when consistent
 */
export function receiverChainConflict(point, event, newReceiver) {
    if (!event || event.type !== 'Throw' || event.score_flag) return null;
    const next = nextInPossession(point, event);
    if (!next || (next.type !== 'Throw' && next.type !== 'Turnover')) return null;
    const nextThrower = nameOf(next.thrower);
    const receiver = nameOf(newReceiver);
    if (!nextThrower || !receiver || nextThrower === receiver) return null;
    return { next, thrower: nextThrower };
}

/**
 * The event that precedes `event` within the same possession, or null.
 */
export function prevInPossession(point, event) {
    const at = locateEvent(point, event);
    if (!at) return null;
    const events = point.possessions[at.possIdx].events || [];
    return at.eventIdx > 0 ? events[at.eventIdx - 1] : null;
}

/**
 * The play that left the disc with this event's thrower: the previous
 * event in the possession, or — for the FIRST event of an offensive
 * possession — the last event of the previous possession when it is an
 * interception (a Defense lives in the defensive possession; the throw it
 * sets up opens the next one).
 */
export function holderSourceOf(point, event) {
    const prev = prevInPossession(point, event);
    if (prev) return prev;
    const at = locateEvent(point, event);
    if (!at || at.eventIdx !== 0 || at.possIdx === 0) return null;
    const before = point.possessions[at.possIdx - 1].events || [];
    const last = before[before.length - 1] || null;
    return (last && last.type === 'Defense' && last.interception_flag) ? last : null;
}

/**
 * The mirror of receiverChainConflict: would giving `event` (a Throw or
 * Turnover) the thrower `newThrower` contradict the previous play? The
 * previous Throw's receiver — or an interception's defender — is whoever
 * releases this one.
 * @returns {{ prev: object, field: 'receiver'|'defender', holder: string }|null}
 *   the conflicting previous event, the field on it that names the
 *   holder, and that holder's name; null when consistent
 */
export function throwerChainConflict(point, event, newThrower) {
    if (!event || (event.type !== 'Throw' && event.type !== 'Turnover')) return null;
    const prev = holderSourceOf(point, event);
    if (!prev) return null;
    let field = null;
    if (prev.type === 'Throw' && !prev.score_flag) field = 'receiver';
    else if (prev.type === 'Defense' && prev.interception_flag && prev.defender) field = 'defender';
    if (!field) return null;
    const holder = nameOf(prev[field]);
    const thrower = nameOf(newThrower);
    if (!holder || !thrower || holder === thrower) return null;
    return { prev, field, holder };
}

// -----------------------------------------------------------------
// Applying a patch.
// -----------------------------------------------------------------
export const PLAYER_FIELDS = Object.freeze(['thrower', 'receiver', 'defender', 'puller', 'assist']);

/** Shallow clone that keeps the prototype (so summarize() still works). */
export function snapshotEvent(event) {
    return Object.assign(Object.create(Object.getPrototypeOf(event)), event);
}

/**
 * Apply `patch` to `event` in place. Accepted keys: the PLAYER_FIELDS
 * (Player refs), `to` (normalized {x, y} | null) and any `*_flag` boolean.
 * A changed `to` cascades to the next event's `from` when it has one (the
 * catch spot is where the next throw is released from), and re-derives the
 * geometry flags of every Throw whose endpoints moved. `score_flag` is
 * deliberately NOT patchable here: flipping a goal changes the score, the
 * point boundary and the roster counters — that is the score-attribution
 * flow's job, not an amendment's.
 * @returns {{ previousEvent: object, changed: object[], cascaded: object|null }}
 *   `changed` lists every event mutated (the event first); `cascaded` is
 *   the next event when its `from` moved
 */
export function applyEventPatch(point, event, patch, fractions) {
    const previousEvent = snapshotEvent(event);
    const changed = [event];
    let cascaded = null;
    Object.keys(patch || {}).forEach(key => {
        if (key === 'score_flag') return;
        if (PLAYER_FIELDS.includes(key)) {
            if (key in event || patch[key]) event[key] = patch[key] || null;
        } else if (key === 'to') {
            if (!('to' in event)) return;
            event.to = copyLoc(patch.to);
            const next = nextInPossession(point, event);
            if (next && 'from' in next && (hasLoc(next.from) || hasLoc(event.to))) {
                next.from = copyLoc(event.to);
                cascaded = next;
                changed.push(next);
            }
        } else if (/_flag$/.test(key)) {
            event[key] = !!patch[key];
        }
    });
    if (patch && 'to' in patch) {
        reclassifyThrow(event, fractions);
        if (cascaded) reclassifyThrow(cascaded, fractions);
    }
    return { previousEvent, changed, cascaded };
}

/**
 * Bridge a receiver change: after `event` (Throw X→Y, now caught by Y) the
 * next play is thrown by Z ≠ Y, so insert Throw Y→Unknown and Throw
 * Unknown→Z, both inferred and unlocated (Decision 11). The two throws take
 * no `at`: timing is never synthesized, so the replay holds on them.
 * @param {object} unknown - the Unknown Player ref
 * @returns {object[]} the inserted events (empty when there is nothing to bridge)
 */
export function insertUnknownBridge(point, event, unknown) {
    const conflict = receiverChainConflict(point, event, event.receiver);
    if (!conflict || !unknown) return [];
    const at = locateEvent(point, event);
    const events = point.possessions[at.possIdx].events;
    const a = new Throw({ thrower: event.receiver, receiver: unknown });
    const b = new Throw({ thrower: unknown, receiver: conflict.next.thrower });
    a.inferred_flag = true;
    b.inferred_flag = true;
    events.splice(at.eventIdx + 1, 0, a, b);
    return [a, b];
}

/**
 * Bridge a thrower change: `event` is now thrown by X but the previous play
 * left the disc with Y, so insert Throw Y→Unknown and Throw Unknown→X just
 * before `event` (same shape as insertUnknownBridge).
 * @returns {object[]} the inserted events (empty when nothing to bridge)
 */
export function insertUnknownBridgeBefore(point, event, unknown) {
    const conflict = throwerChainConflict(point, event, event.thrower);
    if (!conflict || !unknown) return [];
    const at = locateEvent(point, event);
    const events = point.possessions[at.possIdx].events;
    const a = new Throw({ thrower: conflict.prev[conflict.field], receiver: unknown });
    const b = new Throw({ thrower: unknown, receiver: event.thrower });
    a.inferred_flag = true;
    b.inferred_flag = true;
    events.splice(at.eventIdx, 0, a, b);
    return [a, b];
}

// -----------------------------------------------------------------
// Live player counters. createThrow / createDefense increment these on the
// roster Player objects at record time; an amendment that swaps a player
// moves the credit. Only the counters those creators touch are adjusted —
// the point-membership counters (game/pointStats.js) depend on the line,
// not on who threw. Counters clamp at zero.
// -----------------------------------------------------------------
function bump(player, field, delta) {
    if (!player || typeof player !== 'object' || player.name === undefined) return;
    const cur = typeof player[field] === 'number' ? player[field] : 0;
    player[field] = Math.max(0, cur + delta);
}
const sameRef = (a, b) => a === b || (!!a && !!b && nameOf(a) === nameOf(b) && (a.id || null) === (b.id || null));

/**
 * Move completedPasses / goals / assists from the players an event used to
 * credit to the ones it credits now. `previousEvent` is the snapshot
 * applyEventPatch returned.
 * @returns {boolean} true when any counter moved
 */
export function adjustPlayerCounters(previousEvent, event) {
    if (!previousEvent || !event) return false;
    let moved = false;
    const track = (field, fromRef, toRef) => {
        if (sameRef(fromRef, toRef)) return;
        bump(fromRef, field, -1);
        bump(toRef, field, +1);
        moved = true;
    };
    if (event.type === 'Throw') {
        track('completedPasses', previousEvent.thrower, event.thrower);
        if (event.score_flag) {
            track('goals', previousEvent.receiver, event.receiver);
            track('assists', previousEvent.assist || previousEvent.thrower, event.assist || event.thrower);
        }
    } else if (event.type === 'Defense' && event.Callahan_flag) {
        track('goals', previousEvent.defender, event.defender);
    }
    return moved;
}
