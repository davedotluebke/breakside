/*
 * One-time rename of this app's localStorage keys from the `ultistats_`
 * prefix to `breakside_`, left over from the project's original name.
 *
 * This runs before anything reads those keys — it is the first import in
 * main.js — because a rename without it is silent data loss, not a cosmetic
 * change. The sync queue in particular holds writes that have not reached the
 * server yet and exist nowhere else; a coach who tracked a tournament offline
 * would find it gone.
 *
 * Deliberately dependency-free (no logger, no storage module) so that being
 * first in the import graph costs nothing and cannot fail on a half-built
 * module.
 *
 * Copy-then-delete rather than copy-and-keep: these values hold whole rosters
 * and game logs, and localStorage caps out around 5MB, so leaving both copies
 * risks pushing a heavy user over quota — the exact users with the most to
 * lose. The delete only happens once the copy reads back correctly.
 *
 * The public viewer reads some of the same keys but never writes them, so it
 * gets a read-fallback instead of a migration (see viewer.js readShared()).
 */

/** Old key → new key. Order is irrelevant; each is migrated independently. */
const RENAMES = [
    ['ultistats_sync_queue', 'breakside_sync_queue'],
    ['ultistats_local_players', 'breakside_local_players'],
    ['ultistats_local_teams', 'breakside_local_teams'],
    ['ultistats_local_games', 'breakside_local_games'],
    ['ultistats_api_url', 'breakside_api_url'],
];

/**
 * Move any legacy keys onto their new names.
 *
 * Idempotent, and safe to run on every load: a key whose new name already
 * exists is skipped untouched, so this never overwrites current data with a
 * stale copy. Each key is handled independently inside its own try/catch —
 * one failure (a quota error on a large value, a locked-down browser) must
 * not stop the others, since a partial migration is still better than none.
 *
 * @param {Storage} storage
 * @returns {string[]} the new key names actually written
 */
export function migrateStorageKeys(storage) {
    const moved = [];

    for (const [oldKey, newKey] of RENAMES) {
        try {
            // Already migrated, or the new name is in use. Leave the old value
            // alone rather than deleting it: if both exist, something wrote the
            // legacy key after a previous migration, and that is a situation to
            // preserve evidence of, not to tidy away.
            if (storage.getItem(newKey) !== null) continue;

            const value = storage.getItem(oldKey);
            if (value === null) continue;

            storage.setItem(newKey, value);

            // Verify before destroying the original. setItem can fail silently
            // in a few browsers under quota pressure, and this is the moment
            // where a wrong assumption costs the user their data.
            if (storage.getItem(newKey) !== value) {
                console.warn(`[storage] ${oldKey} copy did not verify; leaving original in place`);
                continue;
            }

            storage.removeItem(oldKey);
            moved.push(newKey);
        } catch (err) {
            console.warn(`[storage] could not migrate ${oldKey}:`, err);
        }
    }

    return moved;
}

// Auto-run in the browser. Guarded on `window`, not on `localStorage`: Node 25
// exposes a global localStorage that throws without --localstorage-file, so a
// bare typeof check would run this (and log) during the unit tests.
if (typeof window !== 'undefined' && window.localStorage) {
    migrateStorageKeys(window.localStorage);
}
