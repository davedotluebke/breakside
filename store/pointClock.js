/*
 * Point clock and the first touch — pure leaf module (no imports; pattern:
 * store/pointTimerNormalizer.js) so game/, playByPlay/ and narration/ can all
 * share it without import cycles, and tests/unit/pointClock.test.mjs can pin
 * it.
 *
 * `point.startTimestamp` is the running-segment marker of the point clock
 * (game/gameTimer.js) and `totalPointTime` the banked play time. On an
 * offensive point the pull is still in the air when Start Point is tapped, so
 * the clock used to include the pull's flight and the walk to a brick. The
 * Full and Field tabs record the first touch — a Pickup (pull catch or
 * pick-up) or a dropped pull — so on those surfaces Start Point *arms* the
 * clock instead (`point.clockPending = true`, no startTimestamp) and the
 * first recorded touch starts it. Point time and per-player playing time then
 * measure actual play. Simple mode has no pickup tap, so its offensive
 * clock still starts at Start Point. A defensive point is armed on every
 * surface and starts on the pull: at the stopwatch's release tap when the
 * coach timed the hang (the pull dialog and the Field tab note Date.now()
 * at that tap and pass it as `thrownAt` / the Date to startPointClock),
 * else when the pull is recorded (Proceed, or the landing / Brick tap), else
 * when the dialog is dismissed or the in-field flow abandoned — the pull was
 * thrown either way, so an armed D point is never left waiting.
 *
 * A pending clock is persisted point state (store/storage.js writes
 * `clockPending`, synced like any other point field): a reload or a second
 * coach's device must still see the point as in progress (utils/helpers.js
 * isPointInProgress) with its clock waiting. Undoing the first touch re-arms
 * it (rearmPointClockIfUntouched), dropping the time since the mistaken tap.
 */

// Event types that put a hand on a live disc. Other / Violation are
// annotations (timeouts, subs, calls) and never start the clock.
export const TOUCH_EVENT_TYPES = Object.freeze(['Throw', 'Turnover', 'Defense', 'Pull', 'Pickup']);

export function isTouchEvent(event) {
    return !!event && TOUCH_EVENT_TYPES.includes(event.type);
}

/** True when any event of the point touched the disc. */
export function pointHasTouch(point) {
    return !!point && (point.possessions || []).some(poss => (poss.events || []).some(isTouchEvent));
}

/**
 * An offensive point in which nobody has touched the disc yet: the pull is
 * in the air or on the ground. The Full / Field tabs offer the pull-reception
 * choices (Drops Pull / Catches Pull / Picks Up) while this holds. A fact
 * about the event stream only — independent of how the clock was started.
 */
export function awaitingPull(point) {
    return !!point && point.startingPosition === 'offense' && !pointHasTouch(point);
}

/**
 * Whether Start Point should arm the clock rather than start it.
 *   - Defense: always. The pull is recorded on every surface (the pull
 *     dialog gates Simple / Full / All; the Field tab records it in-field),
 *     and dismissing the dialog or abandoning the in-field flow starts the
 *     clock too.
 *   - Offense: only on a surface that records the first touch ('full' |
 *     'field'); 'simple', 'all' or unknown start the clock at Start Point.
 */
export function clockWaitsForFirstTouch(point, mode) {
    if (!point) return false;
    if (point.startingPosition === 'defense') return true;
    return point.startingPosition === 'offense' && (mode === 'full' || mode === 'field');
}

/** Arm the clock: a started point with no running segment and nothing banked. */
export function armPointClock(point) {
    if (!point) return;
    point.clockPending = true;
    point.startTimestamp = null;
    point.lastPauseTime = null;
    point.totalPointTime = 0;
}

/**
 * First touch: start the running segment if the clock was armed.
 * @param {Date} [now] when the touch happened — the pull flows pass the
 *   stopwatch's release tap, so the segment starts back then
 * @returns {boolean} true when this call started the clock
 */
export function startPointClock(point, now = new Date()) {
    if (!point || !point.clockPending) return false;
    point.clockPending = false;
    point.startTimestamp = now;
    point.lastPauseTime = null;
    return true;
}

/**
 * After an undo: an unconcluded offensive point left with no touch goes back
 * to waiting for its first touch, on the surfaces that defer the clock. The
 * segment that ran since the mistaken touch is dropped, not banked — the
 * point had not started.
 * @returns {boolean} true when the clock was re-armed
 */
export function rearmPointClockIfUntouched(point, mode) {
    if (!point || point.winner || point.endTimestamp || point.clockPending) return false;
    if (pointHasTouch(point) || !clockWaitsForFirstTouch(point, mode)) return false;
    armPointClock(point);
    return true;
}
