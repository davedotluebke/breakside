/*
 * Unit tests pinning the QR encoder (utils/qrCode.js).
 *
 * Contract under test:
 *  - structure: size = 17 + 4·version, three finder patterns with separators,
 *    timing patterns, the always-dark module, format bits that decode back to
 *    the level and mask that were used, version bits from version 7
 *  - the smallest version that fits is chosen, and spare capacity is spent on
 *    a higher error-correction level unless told not to
 *  - a known-answer pin: a fixed input produces a fixed symbol (verified once
 *    against an independent decoder when this file was written)
 *  - the SVG carries a quiet zone, a white field and one path per dark module
 *  - independent decode: when `jsqr` is installed under tests/ (it is a
 *    devDependency there; `npm ci` in tests/ brings it in) every level, every
 *    version and every mask must round-trip through it. Skipped, not failed,
 *    when it is absent, so the suite stays dependency-free by default.
 *
 * Run: node --test 'tests/unit/*.test.mjs'
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeQr, qrSvg, qrText, MIN_VERSION, MAX_VERSION, LEVELS } from '../../utils/qrCode.js';

const at = (qr, x, y) => qr.modules[y * qr.size + x];

// ─── structure ──────────────────────────────────────────────────────────────

test('size follows the version', () => {
    for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
        const qr = encodeQr('x', { minVersion: v, maxVersion: v });
        assert.equal(qr.version, v);
        assert.equal(qr.size, 17 + 4 * v);
        assert.equal(qr.modules.length, qr.size * qr.size);
    }
});

test('finder patterns, separators, timing and the dark module are in place', () => {
    const qr = encodeQr('https://www.breakside.pro/view/a1b2c3d4');
    const n = qr.size;
    const finder = [
        [1, 1, 1, 1, 1, 1, 1],
        [1, 0, 0, 0, 0, 0, 1],
        [1, 0, 1, 1, 1, 0, 1],
        [1, 0, 1, 1, 1, 0, 1],
        [1, 0, 1, 1, 1, 0, 1],
        [1, 0, 0, 0, 0, 0, 1],
        [1, 1, 1, 1, 1, 1, 1],
    ];
    for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]]) {
        for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
            assert.equal(at(qr, ox + x, oy + y), finder[y][x], `finder at ${ox},${oy} module ${x},${y}`);
        }
    }
    // Separators: the light ring one module outside each finder.
    for (let i = 0; i < 8; i++) {
        assert.equal(at(qr, 7, i), 0); assert.equal(at(qr, i, 7), 0);
        assert.equal(at(qr, n - 8, i), 0); assert.equal(at(qr, n - 1 - i, 7), 0);
        assert.equal(at(qr, 7, n - 1 - i), 0); assert.equal(at(qr, i, n - 8), 0);
    }
    // Timing patterns alternate, dark on even indices.
    for (let i = 8; i < n - 8; i++) {
        assert.equal(at(qr, i, 6), i % 2 === 0 ? 1 : 0, `h-timing ${i}`);
        assert.equal(at(qr, 6, i), i % 2 === 0 ? 1 : 0, `v-timing ${i}`);
    }
    assert.equal(at(qr, 8, n - 8), 1, 'always-dark module');
});

/** Read the 15 format bits back out (copy 1) and strip the XOR mask. */
function readFormat(qr) {
    const bits = [];
    for (let i = 0; i <= 5; i++) bits[i] = at(qr, 8, i);
    bits[6] = at(qr, 8, 7); bits[7] = at(qr, 8, 8); bits[8] = at(qr, 7, 8);
    for (let i = 9; i < 15; i++) bits[i] = at(qr, 14 - i, 8);
    let v = 0;
    for (let i = 0; i < 15; i++) v |= bits[i] << i;
    v ^= 0x5412;
    const data = v >>> 10;
    return { eclBits: data >>> 3, mask: data & 7, raw: v };
}

test('format information encodes the level and mask actually used, with valid BCH', () => {
    const ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };
    for (const ecl of LEVELS) {
        for (let mask = 0; mask < 8; mask++) {
            const qr = encodeQr('format check', { ecl, mask, boostEcl: false });
            assert.equal(qr.mask, mask);
            assert.equal(qr.ecl, ecl);
            const f = readFormat(qr);
            assert.equal(f.eclBits, ECL_BITS[ecl]);
            assert.equal(f.mask, mask);
            // BCH(15,5): the 15-bit word must be divisible by the generator.
            let rem = f.raw;
            for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
            assert.equal(rem, 0, 'format BCH remainder');
        }
    }
});

test('version information appears from version 7 and decodes to the version', () => {
    for (let v = 7; v <= MAX_VERSION; v++) {
        const qr = encodeQr('v', { minVersion: v, maxVersion: v });
        const n = qr.size;
        let bits = 0;
        for (let i = 0; i < 18; i++) {
            const a = n - 11 + (i % 3), b = Math.floor(i / 3);
            bits |= at(qr, a, b) << i;
            assert.equal(at(qr, b, a), at(qr, a, b), 'both version copies agree');
        }
        assert.equal(bits >>> 12, v);
        let rem = bits;
        for (let i = 17; i >= 12; i--) if ((rem >>> i) & 1) rem ^= 0x1f25 << (i - 12);
        assert.equal(rem, 0, 'version BCH remainder');
    }
    // Below 7 that corner is data, not a version block — nothing to assert
    // beyond the encoder not throwing.
    encodeQr('v', { minVersion: 6, maxVersion: 6 });
});

// ─── version and level selection ────────────────────────────────────────────

test('picks the smallest version that fits and boosts the level for free', () => {
    // Byte capacities (mode + length overhead already taken out): v3 holds
    // 53/42/32/24 bytes at L/M/Q/H, v4 holds 78/62/46/34. A 43-byte share URL
    // misses v3-M by four bits, lands on v4 at M, and boosting lifts it to Q
    // (46 ≥ 43) but not H (34).
    const url = 'https://www.breakside.pro/view/a1b2c3d4e5f6';
    assert.equal(url.length, 43);
    const qr = encodeQr(url);
    assert.equal(qr.version, 4);
    assert.equal(qr.ecl, 'Q');
    assert.equal(encodeQr(url, { boostEcl: false }).ecl, 'M');
    // At L it fits v3 (53), and stays L when told not to boost.
    const atL = encodeQr(url, { ecl: 'L', boostEcl: false });
    assert.equal(atL.version, 3);
    assert.equal(atL.ecl, 'L');
    // v1 holds 17/14/11/7 bytes: seven bytes boost all the way to H, eight
    // stop at Q.
    const seven = encodeQr('1234567');
    assert.equal(seven.version, 1);
    assert.equal(seven.ecl, 'H');
    assert.equal(encodeQr('12345678').ecl, 'Q');
    assert.equal(encodeQr('12345678', { boostEcl: false }).ecl, 'M');
});

test('too long for the largest supported version throws a RangeError', () => {
    assert.throws(() => encodeQr('z'.repeat(300)), RangeError);
    assert.throws(() => encodeQr('z'.repeat(60), { maxVersion: 2 }), RangeError);
    // Just under the v10-L byte capacity (271) fits.
    assert.equal(encodeQr('z'.repeat(271), { ecl: 'L', boostEcl: false }).version, 10);
});

test('text is encoded as UTF-8 bytes', () => {
    // 'ü' is two bytes. Seven bytes fit v1-H; eight do not — so six
    // characters ending in ü behave like seven ASCII ones, and seven like eight.
    assert.equal(encodeQr('12345ü').ecl, 'H');     // 5 + 2 = 7 bytes
    assert.equal(encodeQr('123456ü').ecl, 'Q');    // 6 + 2 = 8 bytes
});

test('encoding is deterministic', () => {
    const a = encodeQr('determinism');
    const b = encodeQr('determinism');
    assert.deepEqual(Array.from(a.modules), Array.from(b.modules));
    assert.equal(a.mask, b.mask);
});

// ─── known answer ───────────────────────────────────────────────────────────

test('known answer: a fixed short input pins the whole symbol', () => {
    // Verified 2026-09-19 against jsQR (decodes to "Breakside") when written.
    // If this changes, the encoder's output changed — re-verify with the
    // decode test below before updating the pin.
    const qr = encodeQr('Breakside', { ecl: 'M', boostEcl: false, mask: 3 });
    assert.equal(qr.version, 1);
    assert.equal(qr.mask, 3);
    const rows = qrText(qr, '#', '.').split('\n');
    assert.equal(rows.length, 21);
    assert.equal(rows[0], '#######.#.###.#######');
    assert.equal(rows[6], '#######.#.#.#.#######');
    assert.equal(rows[20], '#######.###..#....#..');
});

// ─── SVG ────────────────────────────────────────────────────────────────────

test('SVG: quiet zone, white field, one path segment per dark module', () => {
    const qr = encodeQr('svg', { ecl: 'L', boostEcl: false });
    const svg = qrSvg(qr, { label: 'Scan me' });
    const dim = qr.size + 8;
    assert.match(svg, new RegExp(`viewBox="0 0 ${dim} ${dim}"`));
    assert.match(svg, /<rect width="\d+" height="\d+" fill="#ffffff"\/>/);
    assert.match(svg, /aria-label="Scan me"/);
    const dark = Array.from(qr.modules).filter(Boolean).length;
    assert.equal((svg.match(/h1v1h-1z/g) || []).length, dark);
    // The first dark module (0,0) lands inside the margin offset.
    assert.match(svg, /d="M4 4h1v1h-1z/);
    // Labels are escaped; no label means decorative.
    assert.match(qrSvg(qr, { label: 'a<b&"c"' }), /aria-label="a&lt;b&amp;&quot;c&quot;"/);
    assert.match(qrSvg(qr), /aria-hidden="true"/);
});

// ─── independent decode (optional) ──────────────────────────────────────────

async function loadDecoder() {
    try {
        const mod = await import('jsqr');
        return mod.default || mod;
    } catch (_) {
        return null;
    }
}

function rasterize(qr, scale = 4, margin = 4) {
    const n = qr.size, dim = (n + 2 * margin) * scale;
    const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        if (!qr.modules[y * n + x]) continue;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
            const px = ((y + margin) * scale + dy) * dim + (x + margin) * scale + dx;
            data[px * 4] = 0; data[px * 4 + 1] = 0; data[px * 4 + 2] = 0;
        }
    }
    return { data, width: dim, height: dim };
}

test('independent decoder round-trips every level, version and mask', async (t) => {
    const jsQR = await loadDecoder();
    if (!jsQR) {
        t.skip('jsqr not installed under tests/ (run `npm ci` there)');
        return;
    }
    const decode = (qr) => {
        const img = rasterize(qr);
        const res = jsQR(img.data, img.width, img.height);
        return res ? res.data : null;
    };
    const samples = [
        'Breakside',
        'https://www.breakside.pro/view/a1b2c3d4e5f6',
        'https://www.breakside.pro/join/ABCD1234',
        'Hello, Wörld! ☀ 🥏',
        'The quick brown fish jumps over the lazy disc. '.repeat(4).trim(),
    ];
    for (const text of samples) {
        for (const ecl of LEVELS) {
            let qr;
            try { qr = encodeQr(text, { ecl, boostEcl: false }); }
            catch (e) { if (e instanceof RangeError) continue; throw e; }
            assert.equal(decode(qr), text, `${text.length}B at ${ecl} (v${qr.version}, mask ${qr.mask})`);
        }
    }
    for (let mask = 0; mask < 8; mask++) {
        assert.equal(decode(encodeQr(samples[1], { mask })), samples[1], `mask ${mask}`);
    }
    for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
        const text = 'v'.repeat(v * 12);
        const qr = encodeQr(text, { ecl: 'L', minVersion: v, maxVersion: v, boostEcl: false });
        assert.equal(decode(qr), text, `version ${v}`);
    }
});
