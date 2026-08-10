/*
 * Change stamps — the "has the server's copy moved?" comparison.
 *
 * A change stamp is an opaque token the server derives from a game's
 * current.json mtime. Clients hold the stamp of the state they last pulled and
 * only refetch when the server reports a different one. Three endpoints emit
 * the same token: the controller ping's `gameStamp`, GET
 * /api/games/{id}/poll's `version`, and the public share poll's `version`.
 *
 * Pure leaf module: no DOM, no timers, no imports. The rules live here, alone,
 * because the dangerous case is the one that looks like nothing — a stamp
 * that's absent rather than different. A `null` stamp means "we don't know",
 * and not-knowing has to mean *refetch*. Invert that by accident and the app
 * goes quiet: no error, no stale-data warning, just a game screen that stops
 * updating. Treating unknown as unchanged is the only way this optimization
 * can lose data, so it is the thing under test
 * (tests/unit/changeStamp.test.mjs).
 */

/**
 * Coerce whatever the wire handed us into a stamp or a null.
 *
 * Stamps are compared, never interpreted, so the only job here is to make
 * comparison total: anything absent or empty becomes null ("unknown"), and
 * everything else becomes a string, so a server that switches an mtime from
 * number to string mid-upgrade doesn't read as a change on every poll.
 *
 * @param {*} value - the raw field from a ping / poll response
 * @returns {string|null}
 */
export function normalizeStamp(value) {
    if (value === null || value === undefined) return null;
    const s = String(value);
    return s === '' ? null : s;
}

/**
 * Whether a fresh stamp means the caller should refetch.
 *
 * @param {string|null} lastSeen - stamp of the state the caller holds, or null
 *     if it holds nothing it can vouch for
 * @param {*} current - the stamp just reported by the server
 * @returns {boolean} true = refetch
 */
export function stampSaysChanged(lastSeen, current) {
    const now = normalizeStamp(current);
    // Unknown current stamp: an old server that doesn't send the field, a
    // failed poll, a ping that hasn't landed yet. We have no evidence the
    // state is still good, so pull.
    if (now === null) return true;
    // Nothing to compare against — first pull of a session, or a deliberate
    // reset after a resume.
    if (normalizeStamp(lastSeen) === null) return true;
    return now !== normalizeStamp(lastSeen);
}
