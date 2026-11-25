/*
 * Narration clip bundling — the pure half of the clip recorder.
 *
 * Turns a saved clip (the raw PCM16 the session streamed to OpenAI, plus
 * the context it ran with) into the files the narration test harness reads
 * (breakside_server/tests/narration/README.md): audio.wav, transcript.txt,
 * roster.json, and a meta.json with everything else the session knew. The
 * store-only ZIP writer lets a bundle leave the phone as one file through
 * the share sheet.
 *
 * No DOM, no imports: tests/unit/clipBundle.test.mjs runs it under node.
 */

const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

/** Milliseconds of audio in a PCM16 mono byte length. */
function pcmDurationMs(byteLength, sampleRate) {
    if (!sampleRate) return 0;
    return Math.round((byteLength / BYTES_PER_SAMPLE) / sampleRate * 1000);
}

/** Wrap little-endian PCM16 mono bytes in a canonical 44-byte RIFF/WAVE header. */
function pcm16ToWav(pcmBytes, sampleRate, channels = 1) {
    const dataLen = pcmBytes.length;
    const out = new Uint8Array(WAV_HEADER_BYTES + dataLen);
    const v = new DataView(out.buffer);
    const tag = (off, s) => { for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i); };
    tag(0, 'RIFF');
    v.setUint32(4, 36 + dataLen, true);
    tag(8, 'WAVE');
    tag(12, 'fmt ');
    v.setUint32(16, 16, true);                                   // fmt chunk size
    v.setUint16(20, 1, true);                                    // PCM
    v.setUint16(22, channels, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * channels * BYTES_PER_SAMPLE, true); // byte rate
    v.setUint16(32, channels * BYTES_PER_SAMPLE, true);          // block align
    v.setUint16(34, 16, true);                                   // bits per sample
    tag(36, 'data');
    v.setUint32(40, dataLen, true);
    out.set(pcmBytes, WAV_HEADER_BYTES);
    return out;
}

// ---------------------------------------------------------------------------
// Store-only ZIP (PKZIP 2.0, method 0). No compression: WAV audio barely
// compresses and the point is a single shareable file, not a small one.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(when) {
    const d = when instanceof Date ? when : new Date(when || Date.now());
    const year = Math.max(1980, d.getFullYear());
    return {
        time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
        date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
}

/**
 * Build a ZIP archive from entries of {name, data} where data is a
 * Uint8Array or a string (UTF-8 encoded). Names are stored as UTF-8 (general
 * purpose bit 11). Returns the archive bytes.
 */
function zipStore(entries, mtime) {
    const enc = new TextEncoder();
    const { time, date } = dosDateTime(mtime);
    const parts = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
        const name = enc.encode(e.name);
        const data = e.data instanceof Uint8Array ? e.data : enc.encode(String(e.data));
        const crc = crc32(data);

        const local = new Uint8Array(30 + name.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);           // version needed
        lv.setUint16(6, 0x0800, true);       // flags: UTF-8 names
        lv.setUint16(8, 0, true);            // method: store
        lv.setUint16(10, time, true);
        lv.setUint16(12, date, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, data.length, true); // compressed size
        lv.setUint32(22, data.length, true); // uncompressed size
        lv.setUint16(26, name.length, true);
        lv.setUint16(28, 0, true);           // extra length
        local.set(name, 30);

        const central = new Uint8Array(46 + name.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);           // version made by
        cv.setUint16(6, 20, true);           // version needed
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, time, true);
        cv.setUint16(14, date, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, name.length, true);
        cv.setUint16(30, 0, true);           // extra length
        cv.setUint16(32, 0, true);           // comment length
        cv.setUint16(34, 0, true);           // disk number
        cv.setUint16(36, 0, true);           // internal attrs
        cv.setUint32(38, 0, true);           // external attrs
        cv.setUint32(42, offset, true);      // local header offset
        central.set(name, 46);

        parts.push(local, data);
        centrals.push(central);
        offset += local.length + data.length;
    }
    const cdSize = centrals.reduce((n, c) => n + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    const out = new Uint8Array(offset + cdSize + eocd.length);
    let p = 0;
    for (const part of parts) { out.set(part, p); p += part.length; }
    for (const c of centrals) { out.set(c, p); p += c.length; }
    out.set(eocd, p);
    return out;
}

// ---------------------------------------------------------------------------
// Scenario bundle
// ---------------------------------------------------------------------------

/**
 * The files for one clip, in the harness's scenario layout. `expected.json`
 * is deliberately NOT written: ground truth is hand-checked. The model's own
 * answer goes in as a *.draft.json to be corrected and renamed.
 *
 * @param {object} clip - saved clip record (see clipRecorder.js), pcm omitted
 * @param {Uint8Array} pcmBytes - the clip's raw PCM16 mono little-endian audio
 * @returns {Array<{name:string, data:(Uint8Array|string)}>}
 */
function buildClipBundle(clip, pcmBytes) {
    // game_context is null for a clip that was not narrated inside a game
    // (the squad picker); an invented one would read as real.
    const rosterFile = {
        roster: clip.roster || [],
        game_context: clip.gameContext || null
    };
    const app = clip.app || {};
    const meta = {
        id: clip.id,
        created_at: clip.createdAt,
        kind: clip.kind,
        session_mode: clip.mode,
        transcription_model: clip.transcriptionModel || null,
        sample_rate: clip.sampleRate,
        duration_ms: clip.durationMs,
        aborted: !!clip.aborted,
        on_field: clip.onField || [],
        game_id: clip.gameId || null,
        app_version: app.version || null,
        app_build: app.build || null,
        app_deploy_label: app.deployLabel || null,
        result: clip.result || null
    };
    const entries = [
        { name: 'audio.wav', data: pcm16ToWav(pcmBytes, clip.sampleRate) },
        { name: 'transcript.txt', data: (clip.transcript || '').trim() + '\n' },
        { name: 'roster.json', data: JSON.stringify(rosterFile, null, 2) + '\n' },
        { name: 'meta.json', data: JSON.stringify(meta, null, 2) + '\n' }
    ];
    const r = clip.result;
    if (r && r.type === 'finalize' && Array.isArray(r.operations)) {
        const events = r.operations
            .filter(op => op && op.op === 'ADD' && op.event)
            .map(op => op.event);
        entries.push({ name: 'expected.draft.json', data: JSON.stringify(events, null, 2) + '\n' });
    } else if (r && (r.type === 'lineup' || r.type === 'squads')) {
        // What the pass was asked and what it answered: lineup.draft.json or
        // squads.draft.json.
        entries.push({
            name: `${r.type}.draft.json`,
            data: JSON.stringify({ request: r.request || null, response: r.response || null }, null, 2) + '\n'
        });
    }
    return entries;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** breakside-clip-<kind>-<YYYYMMDD-HHMMSS> — local time, so it sorts by when it was said. */
function clipBundleStem(clip) {
    const d = new Date(clip.createdAt || Date.now());
    const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-`
        + `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    return `breakside-clip-${clip.kind || 'unknown'}-${stamp}`;
}

function formatDuration(ms) {
    const s = Math.round((ms || 0) / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m ${pad2(s % 60)}s` : `${s}s`;
}

function formatBytes(n) {
    if (!n) return '0 KB';
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export {
    pcmDurationMs, pcm16ToWav, crc32, zipStore,
    buildClipBundle, clipBundleStem, formatDuration, formatBytes
};
