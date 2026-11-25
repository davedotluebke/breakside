/*
 * narration/transcriptItems.js — the per-item transcript a Realtime
 * transcription session builds, and the "has everything arrived?" answer
 * stop() waits on.
 *
 * The event sequences below are the ones the live API produced in the
 * stop-latency probe (2026-11-25): each named case is a fault the old
 * single-string accumulator had.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createTranscriptItems } from '../../narration/transcriptItems.js';

/** Feed a list of [event, ...args] rows. */
function feed(items, rows) {
    for (const [event, ...args] of rows) items[event](...args);
    return items;
}

test('one utterance: deltas build the text, the completion finalizes it', () => {
    const items = createTranscriptItems();
    feed(items, [
        ['onCommitted', 'a'],
        ['onDelta', 'a', 'Kris'],
        ['onDelta', 'a', ' in'],
        ['onDelta', 'a', ' for'],
        ['onDelta', 'a', ' Wes'],
    ]);
    assert.equal(items.text(), 'Kris in for Wes');
    assert.equal(items.pendingCount(), 1);
    items.onCompleted('a', 'Kris in for Wes.');
    assert.equal(items.text(), 'Kris in for Wes.');
    assert.equal(items.pendingCount(), 0);
});

test('two utterances are joined with a space, not run together', () => {
    const items = createTranscriptItems();
    feed(items, [
        ['onCommitted', 'a'],
        ['onDelta', 'a', 'All players come off, Mia and Dana in.'],
        ['onCompleted', 'a', 'All players come off, Mia and Dana in.'],
        ['onCommitted', 'b'],
        ['onDelta', 'b', 'Kris'],
        ['onCompleted', 'b', 'Kris'],
    ]);
    assert.equal(items.text(), 'All players come off, Mia and Dana in. Kris');
});

test('a name is not glued onto an utterance that ended without punctuation', () => {
    const items = createTranscriptItems();
    feed(items, [
        ['onCommitted', 'a'],
        ['onDelta', 'a', 'All players come off, Mia and Dana in'],
        ['onCompleted', 'a', 'All players come off, Mia and Dana in'],
        ['onCommitted', 'b'],
        ['onDelta', 'b', 'Kris'],
        ['onCompleted', 'b', 'Kris'],
    ]);
    // The old accumulator produced "...Dana inKris".
    assert.equal(items.text(), 'All players come off, Mia and Dana in Kris');
});

test('a later item finishing first neither reorders nor repeats the earlier one', () => {
    const items = createTranscriptItems();
    feed(items, [
        ['onCommitted', 'a'],
        ['onDelta', 'a', 'All players come off, Mia and Dana in.'],
        ['onCommitted', 'b'],
        ['onDelta', 'b', 'Kris'],          // b's text arrives before a completes
        ['onCompleted', 'a', 'All players come off, Mia and Dana in.'],
        ['onCompleted', 'b', 'Kris'],
    ]);
    // The old accumulator produced "...in.KrisAll players come off, ...in.Kris".
    assert.equal(items.text(), 'All players come off, Mia and Dana in. Kris');
});

test('commit order wins even when a later item is transcribed entirely first', () => {
    const items = createTranscriptItems();
    feed(items, [
        ['onCommitted', 'a'],
        ['onCommitted', 'b'],
        ['onDelta', 'b', 'Kris'],
        ['onCompleted', 'b', 'Kris'],
        ['onDelta', 'a', 'Jake and Charlie go in.'],
        ['onCompleted', 'a', 'Jake and Charlie go in.'],
    ]);
    assert.equal(items.text(), 'Jake and Charlie go in. Kris');
});

test('the completed text replaces what the deltas built', () => {
    const items = createTranscriptItems();
    feed(items, [
        ['onCommitted', 'a'],
        ['onDelta', 'a', 'Chris'],
        ['onDelta', 'a', ' in for Wes'],
        ['onCompleted', 'a', 'Kris in for Wes.'],
    ]);
    assert.equal(items.text(), 'Kris in for Wes.');
});

test('an empty completion keeps the delta text; silence adds nothing', () => {
    const items = createTranscriptItems();
    feed(items, [
        ['onCommitted', 'a'],
        ['onDelta', 'a', 'Run it back'],
        ['onCompleted', 'a', ''],
        ['onCommitted', 'noise'],
        ['onCompleted', 'noise', ''],
        ['onCommitted', 'b'],
        ['onCompleted', 'b', '  Kris  '],
    ]);
    assert.equal(items.text(), 'Run it back Kris');
    assert.equal(items.pendingCount(), 0);
});

test('a delta that straggles in after the completion is ignored', () => {
    const items = createTranscriptItems();
    feed(items, [
        ['onCommitted', 'a'],
        ['onDelta', 'a', 'Kris in'],
        ['onCompleted', 'a', 'Kris in for Wes.'],
        ['onDelta', 'a', ' for Wes'],
    ]);
    assert.equal(items.text(), 'Kris in for Wes.');
});

test('a completion alone (a transport that sends no deltas) is enough', () => {
    const items = createTranscriptItems();
    items.onCompleted('a', 'Kris in for Wes.');
    items.onCompleted('b', 'And Nora.');
    assert.equal(items.text(), 'Kris in for Wes. And Nora.');
    assert.equal(items.pendingCount(), 0);
});

test('events without an item id fold into one utterance at a time', () => {
    const items = createTranscriptItems();
    feed(items, [
        ['onDelta', undefined, 'Kris'],
        ['onDelta', undefined, ' in'],
        ['onCompleted', undefined, 'Kris in.'],
        ['onDelta', null, 'Nora'],
        ['onCompleted', null, 'Nora out.'],
    ]);
    assert.equal(items.text(), 'Kris in. Nora out.');
    assert.equal(items.pendingCount(), 0);
    // A commit with no id can never be matched to a completion, so it must
    // not leave something pending forever.
    items.onCommitted(undefined);
    assert.equal(items.pendingCount(), 0);
});

test('a failed transcription closes its item and keeps what was heard', () => {
    const items = createTranscriptItems();
    feed(items, [
        ['onCommitted', 'a'],
        ['onDelta', 'a', 'Kris in'],
        ['onFailed', 'a'],
    ]);
    assert.equal(items.text(), 'Kris in');
    assert.equal(items.pendingCount(), 0);
    assert.equal(items.isSettled(), true);
});

// --- what stop() waits on ---------------------------------------------------

test('settled: nothing asked, nothing pending', () => {
    const items = createTranscriptItems();
    assert.equal(items.isSettled(), true);
    items.onCommitted('a');
    assert.equal(items.isSettled(), false);
    items.onCompleted('a', 'Run it back.');
    assert.equal(items.isSettled(), true);
});

test('stop after a pause: the empty-commit refusal settles at once', () => {
    // The detector committed and transcribed everything before the tap. The
    // old stop() then waited four seconds for a completion that never came.
    const items = createTranscriptItems();
    feed(items, [
        ['onCommitted', 'a'],
        ['onDelta', 'a', 'All players come off, Mia and Dana in.'],
        ['onCompleted', 'a', 'All players come off, Mia and Dana in.'],
        ['expectCommit'],
    ]);
    assert.equal(items.isSettled(), false, 'waiting for the answer to the manual commit');
    items.onCommitRejected();
    assert.equal(items.isSettled(), true);
});

test('stop right after speaking: waits for the committed item to complete', () => {
    const items = createTranscriptItems();
    items.expectCommit();
    assert.equal(items.isSettled(), false);
    items.onCommitted('a');
    assert.equal(items.isSettled(), false, 'committed but not yet transcribed');
    items.onDelta('a', 'Kris in for Wes');
    assert.equal(items.isSettled(), false);
    items.onCompleted('a', 'Kris in for Wes.');
    assert.equal(items.isSettled(), true);
});

test('the lost add-on: an earlier completion after the tap does not settle it', () => {
    // "...Mia and Dana in." (pause) "Kris", tap. The first phrase was
    // committed by the detector and is still being transcribed at the tap.
    const items = createTranscriptItems();
    feed(items, [
        ['onCommitted', 'a'],
        ['expectCommit'],                                         // the tap
        ['onDelta', 'a', 'All players come off, Mia and Dana in.'],
        ['onCompleted', 'a', 'All players come off, Mia and Dana in.'],
    ]);
    // The old stop() resolved here and closed the socket, losing "Kris".
    assert.equal(items.isSettled(), false, 'the manual commit has not been answered yet');
    items.onCommitted('b');
    assert.equal(items.isSettled(), false);
    items.onCompleted('b', 'Kris');
    assert.equal(items.isSettled(), true);
    assert.equal(items.text(), 'All players come off, Mia and Dana in. Kris');
});

test('the answer to the commit arrives before the earlier item completes', () => {
    const items = createTranscriptItems();
    feed(items, [
        ['onCommitted', 'a'],
        ['expectCommit'],
        ['onCommitted', 'b'],
        ['onCompleted', 'b', 'Kris'],
    ]);
    assert.equal(items.isSettled(), false, 'the first phrase is still pending');
    items.onCompleted('a', 'Mia and Dana in.');
    assert.equal(items.isSettled(), true);
    assert.equal(items.text(), 'Mia and Dana in. Kris');
});

test('an earlier item still pending when the commit is refused keeps stop waiting', () => {
    const items = createTranscriptItems();
    feed(items, [
        ['onCommitted', 'a'],
        ['expectCommit'],
        ['onCommitRejected'],
    ]);
    assert.equal(items.isSettled(), false);
    items.onCompleted('a', 'Run it back and sub Mia in for Alice.');
    assert.equal(items.isSettled(), true);
});

test('reset clears text, pending items and a commit that was awaited', () => {
    const items = createTranscriptItems();
    feed(items, [
        ['onCommitted', 'a'],
        ['onDelta', 'a', 'Kris'],
        ['expectCommit'],
    ]);
    items.reset();
    assert.equal(items.text(), '');
    assert.equal(items.pendingCount(), 0);
    assert.equal(items.isSettled(), true);
});

// --- wiring tripwires --------------------------------------------------------
// realtimeSession.js isn't importable under node (see
// narrationRealtimeSocket.test.mjs), so its use of this module is pinned by
// source text here and exercised in the browser by
// tests/scenarios/27-narration-stop-path.spec.ts.

const here = dirname(fileURLToPath(import.meta.url));
const session = readFileSync(join(here, '../../narration/realtimeSession.js'), 'utf8');

test('realtimeSession tracks committed items and waits on them in stop()', () => {
    assert.ok(session.includes("case 'input_audio_buffer.committed':"),
        'the session must register committed items; without that stop() cannot ' +
        'tell a pending last utterance from a finished session');
    assert.ok(session.includes('expectCommit()'),
        'stop() must wait for the answer to its manual commit');
    assert.ok(session.includes('isSettled()'),
        'stop() must wait until every committed item has its transcript');
});
