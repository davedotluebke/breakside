/*
 * Sign-out backup lifecycle.
 *
 * clearLocalData() (auth/auth.js) wipes every roster, player name, jersey
 * number and game log on the device. The backup it takes first is the net
 * under the confirm prompt in teams/syncStatusUI.js — for the coach who
 * mis-taps Sign Out, or clicks through it, with work that never reached the
 * cloud.
 *
 * But a verbatim copy of that data outliving the sign-out is exactly what
 * signing out is supposed to prevent. The deployment this app actually has is
 * a club tablet passed between coaches on a sideline: a snapshot that sat in
 * localStorage forever let the next coach read the previous coach's rosters
 * straight out of devtools, while the dialog promised the device had been
 * erased.
 *
 * This module owns the compromise. A snapshot is only written when there is
 * genuinely unsynced work to protect, and it is destroyed at the first of:
 *   - the next sign-in by anyone other than the coach it belongs to
 *     (reconcileSignIn), and
 *   - the first app boot more than SIGNOUT_BACKUP_MAX_AGE_MS after it was
 *     written (expireIfStale).
 * A sign-in by the *same* coach deliberately keeps it — that is the mis-tap
 * this exists for, and it is the account that could legitimately restore it.
 *
 * There is still no restore UI (see TODO.md § Offline reliability, 1a):
 * recovery is by hand, reading `breakside_signout_backup` from localStorage
 * and writing each entry of its `data` object back under its own key.
 *
 * Pure and storage-injected so it can be unit-tested without a browser
 * (pattern: store/authFetchLogic.js; tests/unit/signOutBackup.test.mjs pins
 * the behavior).
 */

export const SIGNOUT_BACKUP_KEY = 'breakside_signout_backup';

// How long a snapshot may sit on the device. Long enough to survive "I signed
// out last night and my games are gone", reported the next morning; short
// enough that it is not still readable at the next weekend's tournament.
export const SIGNOUT_BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Build the backup controls over an injected storage.
 *
 * @param {object} deps
 * @param {Storage} deps.storage - localStorage, or any getItem/setItem/removeItem trio.
 * @param {function} [deps.now] - () => epoch ms. Injected for tests.
 * @param {function} [deps.log] - Verbose diagnostics sink.
 * @param {function} [deps.warn] - Non-fatal error sink.
 * @returns {{stash: function, discard: function, expireIfStale: function,
 *            reconcileSignIn: function, peek: function}}
 */
export function makeSignOutBackup({
    storage,
    now = () => Date.now(),
    log = () => {},
    warn = () => {},
    maxAgeMs = SIGNOUT_BACKUP_MAX_AGE_MS,
} = {}) {

    /**
     * Delete the snapshot if one is present.
     * Never throws — a failure here must not block signing out or booting.
     * @param {string} reason - Logged, so the lifecycle is traceable in the console.
     * @returns {boolean} true if a snapshot was actually removed.
     */
    function discard(reason) {
        try {
            if (storage.getItem(SIGNOUT_BACKUP_KEY) === null) return false;
            storage.removeItem(SIGNOUT_BACKUP_KEY);
            log('Discarded sign-out backup:', reason);
            return true;
        } catch (e) {
            warn('Could not discard the sign-out backup:', e);
            return false;
        }
    }

    /**
     * Read and parse the stored snapshot.
     * @returns {{present: boolean, parsed: object|null, unreadable: boolean}}
     */
    function peek() {
        let raw;
        try {
            raw = storage.getItem(SIGNOUT_BACKUP_KEY);
        } catch (e) {
            warn('Could not read the sign-out backup:', e);
            return { present: false, parsed: null, unreadable: false };
        }
        if (raw === null || raw === undefined) {
            return { present: false, parsed: null, unreadable: false };
        }
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') {
                return { present: true, parsed: null, unreadable: true };
            }
            return { present: true, parsed, unreadable: false };
        } catch (e) {
            return { present: true, parsed: null, unreadable: true };
        }
    }

    /**
     * Snapshot the given keys' current values, replacing any previous
     * snapshot. Callers must only reach here when there is genuinely unsynced
     * work — see hasUnsyncedWork() in auth/auth.js.
     *
     * @param {string[]} keys - The localStorage keys about to be deleted.
     * @param {object} [opts]
     * @param {string|null} [opts.userId] - Whose data this is. Recorded so a
     *        later sign-in can tell "same coach came back" (keep) from
     *        "someone else is using the tablet" (destroy). A Supabase user id
     *        is an opaque UUID, so this adds no readable identity to storage.
     * @returns {boolean} true if a snapshot was written.
     */
    function stash(keys, { userId = null } = {}) {
        // Drop any previous snapshot BEFORE writing the new one — two reasons.
        // A snapshot is about the size of the live data, so holding two of
        // them plus the originals is the most likely way to hit the storage
        // quota; and a previous coach's snapshot must never survive this wipe
        // just because this one had nothing to save.
        discard('replaced at sign-out');

        try {
            const data = {};
            let anyFound = false;
            for (const key of keys) {
                const value = storage.getItem(key);
                if (value !== null && value !== undefined) {
                    data[key] = value;
                    anyFound = true;
                }
            }
            if (!anyFound) return false;

            storage.setItem(SIGNOUT_BACKUP_KEY, JSON.stringify({
                savedAt: new Date(now()).toISOString(),
                userId: userId || null,
                data,
            }));
            log('Stashed a sign-out backup under', SIGNOUT_BACKUP_KEY);
            return true;
        } catch (e) {
            // Quota exceeded, or storage unavailable. Log and carry on.
            warn('Could not stash a sign-out backup:', e);
            return false;
        }
    }

    /**
     * Boot-time sweep: drop a snapshot that has outlived its usefulness.
     * A snapshot we cannot date or parse is dropped too — it is useless as a
     * safety net but perfectly readable as data, so keeping it is all cost.
     * @returns {boolean} true if a snapshot was removed.
     */
    function expireIfStale() {
        const { present, parsed, unreadable } = peek();
        if (!present) return false;
        if (unreadable) return discard('unreadable');

        const savedAtMs = Date.parse(parsed.savedAt);
        if (!Number.isFinite(savedAtMs)) return discard('undated');
        // A future savedAt (clock moved backwards) is left alone rather than
        // treated as infinitely old; the sign-in reconcile still bounds it.
        if (now() - savedAtMs >= maxAgeMs) return discard('older than the retention window');
        return false;
    }

    /**
     * Called when a session becomes active. Keeps the snapshot only for the
     * account that produced it; anyone else signing in on this device
     * destroys it.
     *
     * @param {string|null} userId - The id of the user who just signed in.
     * @returns {boolean} true if a snapshot was removed.
     */
    function reconcileSignIn(userId) {
        const { present, parsed, unreadable } = peek();
        if (!present) return false;
        if (unreadable) return discard('unreadable');

        const owner = parsed.userId || null;
        if (owner && userId && owner === userId) {
            // Same coach came back — this is the mis-tap the backup exists
            // for. Keep it until it ages out.
            return false;
        }
        return discard(owner && userId
            ? 'a different account signed in'
            : 'signed in and the backup has no verified owner');
    }

    return { stash, discard, expireIfStale, reconcileSignIn, peek };
}
