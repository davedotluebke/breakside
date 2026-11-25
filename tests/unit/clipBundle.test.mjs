/*
 * Unit tests for narration/clipBundle.js — WAV framing, the store-only ZIP
 * writer (parsed back structurally), and the scenario bundle contents.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    pcmDurationMs, pcm16ToWav, crc32, zipStore,
    buildClipBundle, clipBundleStem, formatDuration, formatBytes,
} from '../../narration/clipBundle.js';

const ascii = (bytes, off, len) => String.fromCharCode(...bytes.subarray(off, off + len));

test('pcmDurationMs: 24 kHz PCM16 mono', () => {
    assert.equal(pcmDurationMs(24000 * 2, 24000), 1000);
    assert.equal(pcmDurationMs(0, 24000), 0);
    assert.equal(pcmDurationMs(1000, 0), 0);
});

test('pcm16ToWav: canonical 44-byte header, payload copied verbatim', () => {
    const pcm = new Uint8Array([1, 0, 255, 127, 0, 128]); // 3 samples
    const wav = pcm16ToWav(pcm, 24000);
    const v = new DataView(wav.buffer);
    assert.equal(wav.length, 44 + 6);
    assert.equal(ascii(wav, 0, 4), 'RIFF');
    assert.equal(v.getUint32(4, true), 36 + 6);
    assert.equal(ascii(wav, 8, 4), 'WAVE');
    assert.equal(ascii(wav, 12, 4), 'fmt ');
    assert.equal(v.getUint16(20, true), 1);      // PCM
    assert.equal(v.getUint16(22, true), 1);      // mono
    assert.equal(v.getUint32(24, true), 24000);
    assert.equal(v.getUint32(28, true), 48000);  // byte rate
    assert.equal(v.getUint16(32, true), 2);      // block align
    assert.equal(v.getUint16(34, true), 16);
    assert.equal(ascii(wav, 36, 4), 'data');
    assert.equal(v.getUint32(40, true), 6);
    assert.deepEqual([...wav.subarray(44)], [...pcm]);
});

test('crc32 matches the reference vector', () => {
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
    assert.equal(crc32(new Uint8Array(0)), 0);
});

test('zipStore: local headers, central directory and EOCD agree', () => {
    const enc = new TextEncoder();
    const entries = [
        { name: 'a.txt', data: 'hello\n' },
        { name: 'dir/b.bin', data: new Uint8Array([0, 1, 2, 3, 4]) },
    ];
    const zip = zipStore(entries, new Date(2026, 8, 29, 10, 30, 0));
    const v = new DataView(zip.buffer);

    // EOCD at the tail.
    const eocd = zip.length - 22;
    assert.equal(v.getUint32(eocd, true), 0x06054b50);
    assert.equal(v.getUint16(eocd + 8, true), 2);
    assert.equal(v.getUint16(eocd + 10, true), 2);
    const cdSize = v.getUint32(eocd + 12, true);
    const cdOffset = v.getUint32(eocd + 16, true);
    assert.equal(cdOffset + cdSize, eocd);

    // Walk the central directory and check each local header + payload.
    let p = cdOffset;
    for (const e of entries) {
        assert.equal(v.getUint32(p, true), 0x02014b50);
        assert.equal(v.getUint16(p + 10, true), 0, 'method store');
        const crc = v.getUint32(p + 16, true);
        const size = v.getUint32(p + 20, true);
        const nameLen = v.getUint16(p + 28, true);
        const localOff = v.getUint32(p + 42, true);
        assert.equal(ascii(zip, p + 46, nameLen), e.name);

        assert.equal(v.getUint32(localOff, true), 0x04034b50);
        assert.equal(v.getUint16(localOff + 6, true) & 0x0800, 0x0800, 'UTF-8 names flag');
        const lNameLen = v.getUint16(localOff + 26, true);
        const data = zip.subarray(localOff + 30 + lNameLen, localOff + 30 + lNameLen + size);
        const expected = e.data instanceof Uint8Array ? e.data : enc.encode(e.data);
        assert.deepEqual([...data], [...expected]);
        assert.equal(crc, crc32(expected));
        p += 46 + nameLen;
    }
    assert.equal(p, eocd);
});

const clip = {
    id: 'clip-1', createdAt: '2026-09-29T10:30:00.000Z', kind: 'events', mode: 'transcription',
    transcriptionModel: 'gpt-4o-mini-transcribe', sampleRate: 24000, durationMs: 125,
    transcript: 'Alice throws to Bob for the score.',
    roster: [{ name: 'Alice', nickname: null, number: '7' }],
    onField: ['Alice', 'Bob'], gameId: 'g-1', gameContext: { offense: true, our_score: 1, their_score: 0, point: 2 },
    result: { type: 'finalize', operations: [
        { op: 'CONFIRM', provisional_id: 'x' },
        { op: 'ADD', event: { kind: 'throw', thrower: 'Alice', receiver: 'Bob', score: true } },
    ] },
};

test('buildClipBundle: harness layout with a draft expected.json from ADD ops', () => {
    const pcm = new Uint8Array(6000);
    const entries = buildClipBundle(clip, pcm);
    const names = entries.map(e => e.name);
    assert.deepEqual(names, ['audio.wav', 'transcript.txt', 'roster.json', 'meta.json', 'expected.draft.json']);
    const byName = Object.fromEntries(entries.map(e => [e.name, e.data]));
    assert.equal(byName['audio.wav'].length, 44 + 6000);
    assert.equal(byName['transcript.txt'], 'Alice throws to Bob for the score.\n');
    const roster = JSON.parse(byName['roster.json']);
    assert.deepEqual(roster.roster, clip.roster);
    assert.equal(roster.game_context.point, 2);
    const meta = JSON.parse(byName['meta.json']);
    assert.equal(meta.kind, 'events');
    assert.equal(meta.duration_ms, 125);
    assert.deepEqual(meta.on_field, ['Alice', 'Bob']);
    assert.ok(!('pcm' in meta));
    const draft = JSON.parse(byName['expected.draft.json']);
    assert.deepEqual(draft, [{ kind: 'throw', thrower: 'Alice', receiver: 'Bob', score: true }]);
});

test('buildClipBundle: lineup clips carry the request/response draft; no result → no draft', () => {
    const lineup = { ...clip, kind: 'lineup', result: { type: 'lineup', request: { transcript: 'Kris in' }, response: { players: ['Kris'] } } };
    const names = buildClipBundle(lineup, new Uint8Array(0)).map(e => e.name);
    assert.ok(names.includes('lineup.draft.json'));
    assert.ok(!names.includes('expected.draft.json'));
    const bare = buildClipBundle({ ...clip, result: null }, new Uint8Array(0)).map(e => e.name);
    assert.deepEqual(bare, ['audio.wav', 'transcript.txt', 'roster.json', 'meta.json']);
});

test('buildClipBundle: a squads clip carries its own draft and no invented game', () => {
    // Narrated in the scrimmage picker, outside any game: no game context is
    // recorded, and none may be made up for the bundle.
    const squads = {
        ...clip, kind: 'squads', onField: [], gameId: null, gameContext: null,
        transcript: 'Alice and Bob on Dark, the rest on Light.',
        result: { type: 'squads',
            request: { transcript: 'Alice and Bob on Dark, the rest on Light.', squad_names: { X: 'Dark', Y: 'Light' },
                roster: [{ name: 'Alice', here: true }, { name: 'Bob', here: true }, { name: 'Dana', here: true }],
                current_squads: { X: [], Y: [] } },
            response: { squads: { X: ['Alice', 'Bob'], Y: ['Dana'] } } },
    };
    const entries = buildClipBundle(squads, new Uint8Array(0));
    const byName = Object.fromEntries(entries.map(e => [e.name, e.data]));
    assert.deepEqual(entries.map(e => e.name),
        ['audio.wav', 'transcript.txt', 'roster.json', 'meta.json', 'squads.draft.json']);
    assert.equal(JSON.parse(byName['roster.json']).game_context, null);
    const meta = JSON.parse(byName['meta.json']);
    assert.equal(meta.kind, 'squads');
    assert.equal(meta.game_id, null);
    assert.deepEqual(meta.on_field, []);
    const draft = JSON.parse(byName['squads.draft.json']);
    assert.deepEqual(draft.request.squad_names, { X: 'Dark', Y: 'Light' });
    assert.deepEqual(draft.response.squads.X, ['Alice', 'Bob']);
    assert.match(clipBundleStem(squads), /^breakside-clip-squads-\d{8}-\d{6}$/);
});

test('buildClipBundle: meta says which build heard the clip', () => {
    const withApp = { ...clip, app: { version: '2.27.0', build: '1653', deployLabel: 'narration-clips v3' } };
    const meta = JSON.parse(Object.fromEntries(buildClipBundle(withApp, new Uint8Array(0)).map(e => [e.name, e.data]))['meta.json']);
    assert.equal(meta.app_version, '2.27.0');
    assert.equal(meta.app_build, '1653');
    assert.equal(meta.app_deploy_label, 'narration-clips v3');
    // A clip saved before the build was recorded: the fields are there, null.
    const old = JSON.parse(Object.fromEntries(buildClipBundle(clip, new Uint8Array(0)).map(e => [e.name, e.data]))['meta.json']);
    assert.equal(old.app_version, null);
    assert.equal(old.app_build, null);
    assert.equal(old.app_deploy_label, null);
});

test('names and formatting helpers', () => {
    assert.match(clipBundleStem(clip), /^breakside-clip-events-\d{8}-\d{6}$/);
    assert.equal(formatDuration(4500), '5s');
    assert.equal(formatDuration(125000), '2m 05s');
    assert.equal(formatBytes(0), '0 KB');
    assert.equal(formatBytes(2048), '2 KB');
    assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});
