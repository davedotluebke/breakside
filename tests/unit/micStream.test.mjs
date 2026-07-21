/*
 * Unit tests for narration/micStream.js — the warm mic-stream cache that
 * stops iOS from re-prompting for microphone permission on every recording.
 *
 * micStream is deliberately a leaf module (no imports) so it loads under
 * node; getUserMedia is injected through the test seam.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { micStream } from '../../narration/micStream.js';

function makeFakeGum() {
    const calls = [];
    const gum = async (constraints) => {
        calls.push(constraints);
        const track = {
            readyState: 'live',
            onended: null,
            // Real MediaStreamTrack.stop() does NOT fire onended — mirror that.
            stop() { this.readyState = 'ended'; }
        };
        return { track, getTracks: () => [track] };
    };
    return { gum, calls };
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, channelCount: 1 };

let fake;
beforeEach(() => {
    micStream.release();  // micStream is a singleton — reset between tests
    fake = makeFakeGum();
    micStream._setGetUserMediaForTests(fake.gum);
});

test('reuses the warm stream across acquire/idle cycles (no second prompt)', async () => {
    const s1 = await micStream.acquire(CONSTRAINTS);
    micStream.idle(60_000);
    const s2 = await micStream.acquire(CONSTRAINTS);
    assert.equal(s2, s1);
    assert.equal(fake.calls.length, 1);
    assert.equal(s1.track.readyState, 'live');
});

test('passes constraints to getUserMedia under an audio key', async () => {
    await micStream.acquire(CONSTRAINTS);
    assert.deepEqual(fake.calls[0], { audio: CONSTRAINTS });
});

test('idle(0) releases immediately (the opt-out of warm holding)', async () => {
    const s = await micStream.acquire(CONSTRAINTS);
    micStream.idle(0);
    assert.equal(s.track.readyState, 'ended');
    assert.equal(micStream.isHeld(), false);
    await micStream.acquire(CONSTRAINTS);
    assert.equal(fake.calls.length, 2);
});

test('releases after the idle hold elapses', async () => {
    const s = await micStream.acquire(CONSTRAINTS);
    micStream.idle(20);
    assert.equal(s.track.readyState, 'live');   // still warm...
    await sleep(80);
    assert.equal(s.track.readyState, 'ended');  // ...released by the timer
    assert.equal(micStream.isHeld(), false);
});

test('re-acquiring cancels a pending idle release', async () => {
    const s = await micStream.acquire(CONSTRAINTS);
    micStream.idle(30);
    await micStream.acquire(CONSTRAINTS);
    await sleep(90);
    assert.equal(s.track.readyState, 'live');
    assert.equal(fake.calls.length, 1);
});

test('changed constraints force a fresh stream so new settings apply', async () => {
    const s1 = await micStream.acquire(CONSTRAINTS);
    micStream.idle(60_000);
    const s2 = await micStream.acquire({ ...CONSTRAINTS, echoCancellation: false });
    assert.notEqual(s2, s1);
    assert.equal(s1.track.readyState, 'ended');  // old stream fully released
    assert.equal(fake.calls.length, 2);
});

test('a dead track is never reused — next acquire re-requests', async () => {
    const s1 = await micStream.acquire(CONSTRAINTS);
    micStream.idle(60_000);
    // Simulate iOS killing the track (long background, mic taken by a call)
    s1.track.readyState = 'ended';
    if (s1.track.onended) s1.track.onended();
    assert.equal(micStream.isHeld(), false);
    const s2 = await micStream.acquire(CONSTRAINTS);
    assert.notEqual(s2, s1);
    assert.equal(fake.calls.length, 2);
});

test('releaseIfIdle is a no-op while capturing, releases once idle', async () => {
    const s = await micStream.acquire(CONSTRAINTS);
    micStream.releaseIfIdle();               // in use — must not yank tracks
    assert.equal(s.track.readyState, 'live');
    micStream.idle(60_000);
    micStream.releaseIfIdle();               // idle — game exit releases
    assert.equal(s.track.readyState, 'ended');
    assert.equal(micStream.isHeld(), false);
});
