/*
 * Narration clip storage — IndexedDB, this browser only.
 *
 * Audio never has a server path: the only way a clip leaves the device is
 * the coach exporting it (clipRecorder.js). Each record holds the raw PCM16
 * as a Blob plus the session context; see clipRecorder.js for the shape.
 *
 * Every function rejects when IndexedDB is unavailable (private browsing,
 * storage blocked); the recorder degrades to a toast, never to a failure
 * of the narration itself.
 */

const DB_NAME = 'breakside-narration-clips';
const DB_VERSION = 1;
const STORE = 'clips';

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB unavailable'));
            return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'id' });
                store.createIndex('createdAt', 'createdAt', { unique: false });
            }
        };
        req.onsuccess = () => {
            const db = req.result;
            // A version bump from another tab closes us; reopen lazily.
            db.onversionchange = () => { db.close(); dbPromise = null; };
            resolve(db);
        };
        req.onerror = () => { dbPromise = null; reject(req.error || new Error('IndexedDB open failed')); };
        req.onblocked = () => { dbPromise = null; reject(new Error('IndexedDB open blocked')); };
    });
    return dbPromise;
}

function tx(mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        try {
            result = fn(store);
        } catch (err) {
            reject(err);
            return;
        }
        // The callback returns either an IDBRequest (read its result once the
        // transaction commits) or a plain value to hand back as-is.
        t.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
        t.onerror = () => reject(t.error || new Error('IndexedDB transaction failed'));
        t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
    }));
}

function putClip(clip) {
    return tx('readwrite', store => { store.put(clip); return clip.id; });
}

function getClip(id) {
    return tx('readonly', store => store.get(id));
}

/** All clips, newest first. Blobs come back as references; reading them is lazy. */
function listClips() {
    return tx('readonly', store => store.getAll()).then(rows =>
        (rows || []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    );
}

function deleteClip(id) {
    return tx('readwrite', store => { store.delete(id); return id; });
}

function clearClips() {
    return tx('readwrite', store => { store.clear(); return true; });
}

/** Merge `patch` into an existing record; a no-op if the clip is gone. */
async function updateClip(id, patch) {
    const existing = await getClip(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    await putClip(merged);
    return merged;
}

/**
 * Drop clips past `maxAgeMs`, then the oldest until the total is under
 * `maxBytes`. Returns the ids removed. The recorder runs this after every
 * save and once at startup, so the store is bounded without the coach
 * managing it.
 */
async function enforceRetention({ maxBytes, maxAgeMs, now = Date.now() }) {
    const clips = await listClips(); // newest first
    const removed = [];
    let keptBytes = 0;
    for (const clip of clips) {
        const age = now - Date.parse(clip.createdAt || 0);
        const tooOld = Number.isFinite(maxAgeMs) && age > maxAgeMs;
        const overCap = Number.isFinite(maxBytes) && keptBytes + (clip.bytes || 0) > maxBytes;
        if (tooOld || overCap) {
            removed.push(clip.id);
        } else {
            keptBytes += clip.bytes || 0;
        }
    }
    for (const id of removed) await deleteClip(id);
    return removed;
}

export { putClip, getClip, listClips, deleteClip, clearClips, updateClip, enforceRetention };
