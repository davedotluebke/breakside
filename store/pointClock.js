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
 * clock still starts at Start Point, and an armed offensive point the coach
 * carries onto the Simple surface starts its clock on arrival
 * (startPointClockOnSurface). A defensive point is armed on every
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
    point.clockStopped = null;
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
 * The coach moved an in-progress point onto a surface. An offensive point
 * armed on Full / Field and carried to a surface with no pickup tap (Simple,
 * All) would otherwise never start its clock, so it starts now. A running
 * clock (someone already picked up the disc) is left alone, and a defensive
 * point keeps waiting for its pull, which every surface records.
 * @returns {boolean} true when this call started the clock
 */
export function startPointClockOnSurface(point, mode, now = new Date()) {
    if (!point || point.winner || point.endTimestamp || !point.clockPending) return false;
    if (point.startingPosition !== 'offense' || clockWaitsForFirstTouch(point, mode)) return false;
    return startPointClock(point, now);
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

// =============================================================================
// Stoppages (ARCHITECTURE.md § Point clock → Stoppages)
// =============================================================================
//
// A timeout, an injury sub, or the header pause button stops a running
// clock: the segment so far is banked, `startTimestamp` is nulled,
// `lastPauseTime` keeps the moment of the stop and `clockStopped` names the
// reason. The next recorded play (any touch event, through pbpPossession /
// the narration engine), the toast's Restart button, or the pause button
// starts a fresh segment. Stopped is persisted point state, like armed: a
// reload or the other coach's device sees the frozen clock, and the toast
// is rebuilt from it (game/clockStoppedToast.js).

/** Why the clock is stopped. */
export const STOP_REASONS = Object.freeze(['timeout', 'injury', 'manual']);

/** True while the live point's clock is stopped for a stoppage. */
export function isPointClockStopped(point) {
    return !!point && !!point.clockStopped && !point.winner && !point.endTimestamp;
}

/**
 * The stop reason an event causes when it is recorded mid-point, or null
 * for anything else (a touch, a lineup correction, a period break).
 */
export function stopReasonOf(event) {
    if (!event || event.type !== 'Other') return null;
    if (event.timeout_flag) return 'timeout';
    if (event.injury_flag) return 'injury';
    return null;
}

/**
 * Stop a running clock. Banks the running segment, keeps the stop moment
 * in lastPauseTime and the reason in clockStopped. A no-op unless the
 * clock is actually running: an armed clock has nothing to stop (the first
 * touch starts it, after the stoppage), a stopped one keeps its first stop
 * (so undoing a later stop event cannot restart a clock it did not stop),
 * and a concluded point is left alone.
 * @param {'timeout'|'injury'|'manual'} reason
 * @returns {boolean} true when this call stopped the clock
 */
export function stopPointClock(point, reason, now = new Date()) {
    if (!point || point.winner || point.endTimestamp) return false;
    if (point.clockPending || point.clockStopped || !point.startTimestamp) return false;
    point.totalPointTime = (point.totalPointTime || 0) +
        (now.getTime() - new Date(point.startTimestamp).getTime());
    point.startTimestamp = null;
    point.lastPauseTime = now;
    point.clockStopped = STOP_REASONS.includes(reason) ? reason : 'manual';
    return true;
}

/**
 * Restart a stopped clock: a fresh running segment from `now`. The time of
 * the stoppage is not play and stays out of the point.
 * @returns {boolean} true when this call restarted the clock
 */
export function restartPointClock(point, now = new Date()) {
    if (!isPointClockStopped(point)) return false;
    point.clockStopped = null;
    point.startTimestamp = now;
    point.lastPauseTime = null;
    return true;
}

/**
 * A recorded touch, on any surface: starts an armed clock or restarts a
 * stopped one, else nothing. The creators in pbpPossession and the
 * narration engine call this after appending a touch event.
 * @returns {'started'|'restarted'|null}
 */
export function touchPointClock(point, now = new Date()) {
    if (startPointClock(point, now)) return 'started';
    if (restartPointClock(point, now)) return 'restarted';
    return null;
}

/**
 * Undo of the event that stopped the clock: the clock runs again from the
 * moment it stopped, as if the stoppage had never been recorded, so a
 * mis-tapped Timeout costs no time. Only for the stop's own reason — a
 * timeout undone while the clock is stopped for an injury sub, or by hand,
 * leaves it stopped.
 * @returns {boolean} true when the clock was resumed
 */
export function resumePointClockFromStop(point, reason) {
    if (!reason || !isPointClockStopped(point) || point.clockStopped !== reason) return false;
    const since = point.lastPauseTime ? new Date(point.lastPauseTime) : new Date();
    point.clockStopped = null;
    point.startTimestamp = since;
    point.lastPauseTime = null;
    return true;
}

/** How long the clock has been stopped, in ms (0 when it is not). */
export function clockStoppedForMs(point, now = Date.now()) {
    if (!isPointClockStopped(point) || !point.lastPauseTime) return 0;
    return Math.max(0, now - new Date(point.lastPauseTime).getTime());
}
