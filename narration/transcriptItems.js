/*
 * Transcript assembly for a Realtime transcription session, one entry per
 * committed stretch of audio.
 *
 * The server transcribes each stretch it commits — a turn the voice-activity
 * detector closed, or the buffer stop() commits by hand — as its own item:
 *
 *   input_audio_buffer.committed                            {item_id}
 *   conversation.item.input_audio_transcription.delta       {item_id, delta}
 *   conversation.item.input_audio_transcription.completed   {item_id, transcript}
 *   conversation.item.input_audio_transcription.failed      {item_id}
 *
 * Items overlap in time: the coach can say more, and tap stop, while an
 * earlier phrase is still being transcribed. Treating the events as one
 * stream of text got three things wrong (measured against the live API,
 * 2026-11-25; breakside_server/tests/narration/tools/stop_latency_probe.py):
 * phrases ran together with nothing between them ("...Dana in.Kris", and
 * "inKris" when the first had no full stop); a phrase was appended twice
 * when a later one's deltas arrived before its completion; and stop() took
 * the first completion it saw as the end, which dropped a last word still
 * in flight and, when nothing was in flight, waited out its whole timeout.
 *
 * So the text is kept per item and joined in commit order, and the same
 * bookkeeping answers what stop() needs to know: has the server answered
 * the final commit, and does every committed item have its transcript?
 *
 * Pure — no DOM, no network — so it runs under node:
 * tests/unit/transcriptItems.test.mjs.
 */

function createTranscriptItems() {
    let order = [];             // entries in commit order: { id, text, done }
    let byId = new Map();
    // Events with no item_id (not seen from the GA API; older transports)
    // are folded into one open entry at a time, closed by a completion.
    let openAnonymous = null;
    let anonymousCount = 0;
    let commitAnswerPending = false;

    function reset() {
        order = [];
        byId = new Map();
        openAnonymous = null;
        anonymousCount = 0;
        commitAnswerPending = false;
    }

    function entryFor(itemId) {
        if (itemId == null || itemId === '') {
            if (!openAnonymous) {
                openAnonymous = { id: `anonymous-${++anonymousCount}`, text: '', done: false };
                order.push(openAnonymous);
            }
            return openAnonymous;
        }
        let entry = byId.get(itemId);
        if (!entry) {
            entry = { id: itemId, text: '', done: false };
            byId.set(itemId, entry);
            order.push(entry);
        }
        return entry;
    }

    function close(entry) {
        entry.done = true;
        if (entry === openAnonymous) openAnonymous = null;
    }

    /**
     * The server committed a stretch of audio. This is also how it answers
     * a manual commit that had audio to commit, and the event does not say
     * which of the two it is. A detector commit still in flight when stop()
     * asked is therefore read as the answer. That is safe: the real answer
     * follows within a network round trip, long before the in-flight item's
     * transcript can settle things, so a second item is still registered in
     * time; and all the buffer could hold by then is that round trip's worth
     * of audio.
     */
    function onCommitted(itemId) {
        commitAnswerPending = false;
        if (itemId != null && itemId !== '') entryFor(itemId);
    }

    function onDelta(itemId, delta) {
        if (!delta) return;
        const entry = entryFor(itemId);
        // A completion is the item's final text; a straggling delta after
        // it must not be appended to it.
        if (!entry.done) entry.text += delta;
    }

    function onCompleted(itemId, transcript) {
        const entry = entryFor(itemId);
        // The completed text replaces whatever the deltas built. An empty
        // completion (silence, noise) leaves any delta text in place.
        if (typeof transcript === 'string' && transcript.trim()) entry.text = transcript;
        close(entry);
    }

    /** Transcription of an item failed: nothing more will come for it. */
    function onFailed(itemId) {
        close(entryFor(itemId));
    }

    /** stop() sent a manual commit and is waiting to hear what became of it. */
    function expectCommit() {
        commitAnswerPending = true;
    }

    /**
     * The manual commit was refused as empty: the detector had already
     * committed everything, so no new item is coming.
     */
    function onCommitRejected() {
        commitAnswerPending = false;
    }

    /** The transcript so far: items in commit order, one space between them. */
    function text() {
        return order.map(entry => entry.text.trim()).filter(Boolean).join(' ');
    }

    function pendingCount() {
        let n = 0;
        for (const entry of order) if (!entry.done) n++;
        return n;
    }

    /** True once nothing the server still owes can change the transcript. */
    function isSettled() {
        return !commitAnswerPending && pendingCount() === 0;
    }

    return {
        reset,
        onCommitted,
        onDelta,
        onCompleted,
        onFailed,
        expectCommit,
        onCommitRejected,
        text,
        pendingCount,
        isSettled
    };
}

export { createTranscriptItems };
