/*
 * Tripwire for the G5 narration outage (2026-07-04).
 *
 * OpenAI's GA Realtime endpoint accepts the WebSocket handshake and then
 * kills the session (error + close 4000 beta_api_shape_disabled) if the
 * retired beta subprotocol ("openai-beta" + ".realtime-v1") appears in the
 * client's offer at all. The browser client carried that vestigial entry
 * through the GA migration and narration died in the field with no client
 * change — green mic button, silent socket, empty transcript.
 *
 * realtimeSession.js isn't importable under node (it pulls in the browser
 * module graph), so this is a source-text assertion: crude, but it pins the
 * exact one-line regression that caused a two-week outage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '../../narration/realtimeSession.js'), 'utf8');

test('realtimeSession never offers the retired beta subprotocol', () => {
    assert.ok(
        !src.includes('openai-beta'),
        'Found "openai-beta" in realtimeSession.js — offering the beta ' +
        'subprotocol makes OpenAI close the session (4000 ' +
        'beta_api_shape_disabled) and narration silently breaks (G5).'
    );
});

test('realtimeSession still authenticates via the ephemeral-token subprotocol', () => {
    assert.ok(
        src.includes('openai-insecure-api-key.'),
        'The ephemeral client_secret subprotocol is how the browser ' +
        'authenticates the Realtime WebSocket; it must stay in the offer.'
    );
});

test('start() fails loudly when the socket dies during microphone setup', () => {
    assert.ok(
        src.includes('Connection closed during microphone setup'),
        'The post-getUserMedia socket-liveness check is gone. Without it, a ' +
        'socket that dies during the (multi-second, on iOS) mic-permission ' +
        'prompt leaves the UI latched in a green recording state streaming ' +
        'into a closed socket.'
    );
});
