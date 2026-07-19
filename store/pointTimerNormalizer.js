/*
 * Zombie point-timer repair — pure leaf module (no imports; pattern:
 * store/pendingLineLogic.js) so store/storage.js can run it on every
 * deserialize path and tests/unit/pointTimerNormalizer.test.mjs can pin it.
 *
 * `point.startTimestamp` doubles as the running-timer segment marker (see
 * game/gameTimer.js): non-null means "clock running since here", and time
 * displays add `now - startTimestamp` on top of the banked totalPointTime.
 * Only the game's LAST point — unconcluded and recently started — can
 * legitimately be running. Pre-2026-07 score-path bugs (the score-time
 * startTimestamp stamp fixed in updateScore) left running markers behind in
 * stored games: the Nov-2025 SWW-2 game's point 1 (winner "", startTimestamp
 * Nov-16, never concluded) inflated player Game-time displays by
 * elapsed-since-November (~352,7xx minutes) every time the game was reopened,
 * and points 2–13 carry score-time markers alongside their endTimestamps.
 *
 * normalizePointTimers nulls a startTimestamp when the point cannot be live:
 * it is concluded (winner or endTimestamp set), or a later point exists, or
 * the marker is implausibly old (|now − start| > STALE_RUNNING_TIMER_MS — no
 * real point runs 12h, and a far-future marker means the device clock moved,
 * so elapsed math is garbage either way). The stale segment is dropped, NOT
 * banked into totalPointTime: months of phantom elapsed is exactly the
 * corruption being repaired, and the true duration is unknowable. Banked
 * totalPointTime is never touched. A live mid-game reload (last point,
 * unconcluded, fresh marker) passes through untouched, so in-progress timers
 * survive app restarts and cloud refreshes exactly as before.
 */

export const STALE_RUNNING_TIMER_MS = 12 * 60 * 60 * 1000;

/**
 * Null impossible "running" startTimestamps on deserialized points.
 * Mutates the points in place.
 * @param {Array} points - Point instances (startTimestamp as Date) or raw
 *   serialized entries (ISO string) — both forms are handled.
 * @param {number} [now] - ms epoch, injectable for tests
 * @returns {number} how many points were repaired
 */
export function normalizePointTimers(points, now = Date.now()) {
    if (!Array.isArray(points)) { return 0; }
    let repaired = 0;
    points.forEach((point, index) => {
        if (!point || !point.startTimestamp) { return; }
        const concluded = !!point.winner || !!point.endTimestamp;
        const hasLaterPoint = index < points.length - 1;
        const startMs = new Date(point.startTimestamp).getTime();
        const stale = !Number.isFinite(startMs) ||
            Math.abs(now - startMs) > STALE_RUNNING_TIMER_MS;
        if (concluded || hasLaterPoint || stale) {
            point.startTimestamp = null;
            repaired += 1;
        }
    });
    return repaired;
}
