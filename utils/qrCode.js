/*
 * QR code encoder — byte mode, versions 1–10, all four error-correction levels.
 *
 * A pure leaf module: no DOM, no timers, no imports, no side effects. It
 * turns a string into a module matrix (`encodeQr`) and a matrix into an
 * inline SVG string (`qrSvg`). Unit-tested in tests/unit/qrCode.test.mjs,
 * which also decodes the output with an independent decoder when one is
 * installed under tests/.
 *
 * Why hand-rolled rather than vendored: the app ships with no build step and
 * two vendored classic scripts already; the codes it needs are short URLs
 * (share links, invite links — a few dozen bytes), for which the first ten
 * versions are ample, and the encoder for those is ~300 lines that can be
 * read end to end. Versions 11–40 are deliberately absent; `encodeQr` throws
 * rather than silently emitting something a scanner cannot read.
 *
 * Structure follows ISO/IEC 18004 and the shape of Project Nayuki's
 * reference encoder: segment → codewords → Reed–Solomon blocks → interleave
 * → place → mask (lowest penalty of the eight) → format/version bits.
 *
 * Colour is fixed black-on-white with a four-module quiet zone, in both app
 * themes: scanners want a dark code on a light field, and the quiet zone is
 * part of the symbol. That is why `qrSvg` carries literal colours rather than
 * theme tokens (the CSS token lint covers stylesheets, not SVG text).
 */

// ── Tables ──────────────────────────────────────────────────────────────────

/**
 * Error-correction structure per version (1–10) and level:
 * `[ecCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], ...]]`.
 * The second group, where present, holds one more data codeword per block.
 * Every entry sums to the version's total codeword count (26, 44, 70, 100,
 * 134, 172, 196, 242, 292, 346).
 */
const EC_TABLE = [
    null,
    { L: [7, [[1, 19]]],   M: [10, [[1, 16]]],          Q: [13, [[1, 13]]],           H: [17, [[1, 9]]] },
    { L: [10, [[1, 34]]],  M: [16, [[1, 28]]],          Q: [22, [[1, 22]]],           H: [28, [[1, 16]]] },
    { L: [15, [[1, 55]]],  M: [26, [[1, 44]]],          Q: [18, [[2, 17]]],           H: [22, [[2, 13]]] },
    { L: [20, [[1, 80]]],  M: [18, [[2, 32]]],          Q: [26, [[2, 24]]],           H: [16, [[4, 9]]] },
    { L: [26, [[1, 108]]], M: [24, [[2, 43]]],          Q: [18, [[2, 15], [2, 16]]],  H: [22, [[2, 11], [2, 12]]] },
    { L: [18, [[2, 68]]],  M: [16, [[4, 27]]],          Q: [24, [[4, 19]]],           H: [28, [[4, 15]]] },
    { L: [20, [[2, 78]]],  M: [18, [[4, 31]]],          Q: [18, [[2, 14], [4, 15]]],  H: [26, [[4, 13], [1, 14]]] },
    { L: [24, [[2, 97]]],  M: [22, [[2, 38], [2, 39]]], Q: [22, [[4, 18], [2, 19]]],  H: [26, [[4, 14], [2, 15]]] },
    { L: [30, [[2, 116]]], M: [22, [[3, 36], [2, 37]]], Q: [20, [[4, 16], [4, 17]]],  H: [24, [[4, 12], [4, 13]]] },
    { L: [18, [[2, 68], [2, 69]]], M: [26, [[4, 43], [1, 44]]], Q: [24, [[6, 19], [2, 20]]], H: [28, [[6, 15], [2, 16]]] },
];

/** Alignment-pattern centre coordinates per version. */
const ALIGN_POS = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

/** Level → the two format-information bits. */
const ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };

export const MIN_VERSION = 1;
export const MAX_VERSION = EC_TABLE.length - 1;
export const LEVELS = Object.freeze(['L', 'M', 'Q', 'H']);

// ── GF(256) arithmetic and Reed–Solomon ─────────────────────────────────────

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGaloisField() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        GF_EXP[i] = x;
        GF_LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;   // the QR field's primitive polynomial
    }
    for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Generator polynomial of degree n: Π (x − α^i), i = 0..n−1, highest term first. */
function rsGenerator(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
        const next = new Array(g.length + 1).fill(0);
        for (let j = 0; j < g.length; j++) {
            next[j] ^= g[j];
            next[j + 1] ^= gfMul(g[j], GF_EXP[i]);
        }
        g = next;
    }
    return g;
}

/** The n error-correction codewords for one block of data codewords. */
function rsEncode(data, n) {
    const g = rsGenerator(n);
    const rem = new Uint8Array(n);
    for (const b of data) {
        const factor = b ^ rem[0];
        rem.copyWithin(0, 1);
        rem[n - 1] = 0;
        if (factor !== 0) {
            for (let j = 0; j < n; j++) rem[j] ^= gfMul(g[j + 1], factor);
        }
    }
    return rem;
}

// ── Segment → codewords ─────────────────────────────────────────────────────

function totalDataCodewords(version, ecl) {
    return EC_TABLE[version][ecl][1].reduce((sum, [count, cw]) => sum + count * cw, 0);
}

function charCountBits(version) {
    return version <= 9 ? 8 : 16;   // byte mode; versions 1–26 use 8 or 16
}

function fitsIn(byteLength, version, ecl) {
    const needed = 4 + charCountBits(version) + byteLength * 8;
    return needed <= totalDataCodewords(version, ecl) * 8;
}

function toBytes(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(text));
    // Ancient fallback: encodeURIComponent-based UTF-8.
    const s = unescape(encodeURIComponent(String(text)));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

/** Byte-mode bit stream, terminated and padded to the version's capacity. */
function buildCodewords(bytes, version, ecl) {
    const capacity = totalDataCodewords(version, ecl) * 8;
    const bits = [];
    const push = (value, count) => {
        for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    };
    push(0b0100, 4);                       // byte mode
    push(bytes.length, charCountBits(version));
    for (const b of bytes) push(b, 8);
    push(0, Math.min(4, capacity - bits.length));      // terminator
    while (bits.length % 8 !== 0) bits.push(0);          // byte-align
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);

    const codewords = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bits.length; i++) codewords[i >>> 3] |= bits[i] << (7 - (i & 7));
    return codewords;
}

/** Split into blocks, add EC codewords, and interleave into the final sequence. */
function interleave(data, version, ecl) {
    const [ecPerBlock, groups] = EC_TABLE[version][ecl];
    const blocks = [];
    let offset = 0;
    for (const [count, cw] of groups) {
        for (let i = 0; i < count; i++) {
            const block = data.subarray(offset, offset + cw);
            blocks.push({ data: block, ec: rsEncode(block, ecPerBlock) });
            offset += cw;
        }
    }
    const longest = Math.max(...blocks.map(b => b.data.length));
    const out = [];
    for (let i = 0; i < longest; i++) {
        for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
    }
    for (let i = 0; i < ecPerBlock; i++) {
        for (const b of blocks) out.push(b.ec[i]);
    }
    return Uint8Array.from(out);
}

// ── Matrix ──────────────────────────────────────────────────────────────────

class Matrix {
    constructor(version) {
        this.version = version;
        this.size = version * 4 + 17;
        this.modules = new Uint8Array(this.size * this.size);     // 1 = dark
        this.isFunction = new Uint8Array(this.size * this.size);  // reserved
    }

    get(x, y) { return this.modules[y * this.size + x]; }

    setFunction(x, y, dark) {
        const i = y * this.size + x;
        this.modules[i] = dark ? 1 : 0;
        this.isFunction[i] = 1;
    }

    drawFinder(cx, cy) {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const x = cx + dx, y = cy + dy;
                if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue;
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                this.setFunction(x, y, dist !== 2 && dist !== 4);  // ring at 2, separator at 4
            }
        }
    }

    drawAlignment(cx, cy) {
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            }
        }
    }

    drawFunctionPatterns() {
        const n = this.size;
        for (let i = 0; i < n; i++) {
            this.setFunction(6, i, i % 2 === 0);   // vertical timing
            this.setFunction(i, 6, i % 2 === 0);   // horizontal timing
        }
        this.drawFinder(3, 3);
        this.drawFinder(n - 4, 3);
        this.drawFinder(3, n - 4);

        const pos = ALIGN_POS[this.version];
        const last = pos.length - 1;
        for (let i = 0; i < pos.length; i++) {
            for (let j = 0; j < pos.length; j++) {
                // Skip the three that would sit on finder patterns.
                if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
                this.drawAlignment(pos[i], pos[j]);
            }
        }
        this.drawFormatBits('M', 0);   // any values: reserves the area for now
        this.drawVersionBits();
    }

    drawFormatBits(ecl, mask) {
        const data = (ECL_BITS[ecl] << 3) | mask;
        let rem = data;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const bits = ((data << 10) | rem) ^ 0x5412;
        const bit = (i) => ((bits >>> i) & 1) === 1;
        const n = this.size;
        // Copy 1: around the top-left finder.
        for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
        this.setFunction(8, 7, bit(6));
        this.setFunction(8, 8, bit(7));
        this.setFunction(7, 8, bit(8));
        for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
        // Copy 2: split between the other two finders.
        for (let i = 0; i < 8; i++) this.setFunction(n - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++) this.setFunction(8, n - 15 + i, bit(i));
        this.setFunction(8, n - 8, true);   // the always-dark module
    }

    drawVersionBits() {
        if (this.version < 7) return;
        let rem = this.version;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        const bits = (this.version << 12) | rem;   // 18 bits
        const n = this.size;
        for (let i = 0; i < 18; i++) {
            const dark = ((bits >>> i) & 1) === 1;
            const a = n - 11 + (i % 3);
            const b = Math.floor(i / 3);
            this.setFunction(a, b, dark);
            this.setFunction(b, a, dark);
        }
    }

    /** Zigzag the codeword bits into every non-function module. */
    drawCodewords(codewords) {
        const n = this.size;
        const totalBits = codewords.length * 8;
        let i = 0;
        for (let right = n - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;   // hop over the vertical timing column
            for (let vert = 0; vert < n; vert++) {
                for (let j = 0; j < 2; j++) {
                    const x = right - j;
                    const upward = ((right + 1) & 2) === 0;
                    const y = upward ? n - 1 - vert : vert;
                    const idx = y * n + x;
                    if (!this.isFunction[idx] && i < totalBits) {
                        this.modules[idx] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
                        i++;
                    }
                    // Remainder modules (versions 2–6 have seven) stay light.
                }
            }
        }
    }

    /** XOR the mask pattern over the data modules. Involutive: apply twice to undo. */
    applyMask(mask) {
        const n = this.size;
        for (let y = 0; y < n; y++) {
            for (let x = 0; x < n; x++) {
                let invert;
                switch (mask) {
                    case 0: invert = (x + y) % 2 === 0; break;
                    case 1: invert = y % 2 === 0; break;
                    case 2: invert = x % 3 === 0; break;
                    case 3: invert = (x + y) % 3 === 0; break;
                    case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
                    case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
                    case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
                    case 7: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
                    default: throw new RangeError('mask out of range');
                }
                const idx = y * n + x;
                if (invert && !this.isFunction[idx]) this.modules[idx] ^= 1;
            }
        }
    }

    /** ISO 18004 §7.8.3 penalty score; lower is a better-looking, safer symbol. */
    penalty() {
        const n = this.size;
        let result = 0;

        // Rule 1 (runs of five or more) and rule 3 (finder-like 1:1:3:1:1 runs),
        // scanned once per row and once per column.
        const scan = (getAt) => {
            for (let a = 0; a < n; a++) {
                let runColor = 0, runLen = 0;
                const history = [0, 0, 0, 0, 0, 0, 0];
                for (let b = 0; b < n; b++) {
                    const c = getAt(a, b);
                    if (c === runColor) {
                        runLen++;
                        if (runLen === 5) result += 3;
                        else if (runLen > 5) result++;
                    } else {
                        addRun(runLen, history, n);
                        if (!runColor) result += finderLike(history) * 40;
                        runColor = c;
                        runLen = 1;
                    }
                }
                result += terminate(runColor, runLen, history, n) * 40;
            }
        };
        scan((y, x) => this.modules[y * n + x]);
        scan((x, y) => this.modules[y * n + x]);

        // Rule 2: 2×2 blocks of one colour.
        for (let y = 0; y < n - 1; y++) {
            for (let x = 0; x < n - 1; x++) {
                const c = this.modules[y * n + x];
                if (c === this.modules[y * n + x + 1] &&
                    c === this.modules[(y + 1) * n + x] &&
                    c === this.modules[(y + 1) * n + x + 1]) result += 3;
            }
        }

        // Rule 4: dark/light balance, in 5 % steps away from 50 %.
        let dark = 0;
        for (let i = 0; i < this.modules.length; i++) dark += this.modules[i];
        const total = n * n;
        const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
        result += k * 10;
        return result;
    }
}

// Rule-3 helpers: a 1:1:3:1:1 dark/light run with a light margin of 4 on
// either side looks like a finder pattern and confuses locators.
function finderLike(h) {
    const c = h[1];
    const core = c > 0 && h[2] === c && h[3] === c * 3 && h[4] === c && h[5] === c;
    return (core && h[0] >= c * 4 && h[6] >= c ? 1 : 0) + (core && h[6] >= c * 4 && h[0] >= c ? 1 : 0);
}

function addRun(runLen, h, size) {
    if (h[0] === 0) runLen += size;   // the edge counts as light margin
    h.copyWithin(1, 0, 6);
    h[0] = runLen;
}

function terminate(runColor, runLen, h, size) {
    if (runColor) {
        addRun(runLen, h, size);
        runLen = 0;
    }
    runLen += size;
    addRun(runLen, h, size);
    return finderLike(h);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Encode `text` (UTF-8, byte mode) as a QR symbol.
 *
 * Picks the smallest version in [minVersion, maxVersion] that fits at the
 * requested level, then — unless `boostEcl` is false — raises the level as
 * far as that version allows for free, since spare capacity is better spent
 * on error correction than on padding. Mask is the lowest-penalty of the
 * eight, or `mask` if given (0–7).
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {'L'|'M'|'Q'|'H'} [opts.ecl='M']
 * @param {number} [opts.minVersion=1]
 * @param {number} [opts.maxVersion=10]
 * @param {boolean} [opts.boostEcl=true]
 * @param {number} [opts.mask] - force a mask pattern (tests)
 * @returns {{version: number, ecl: string, mask: number, size: number, modules: Uint8Array}}
 *   `modules` is row-major, `size × size`, 1 = dark.
 * @throws {RangeError} when the text does not fit in `maxVersion`
 */
export function encodeQr(text, opts) {
    const o = opts || {};
    let ecl = LEVELS.includes(o.ecl) ? o.ecl : 'M';
    const minV = Math.max(MIN_VERSION, o.minVersion || MIN_VERSION);
    const maxV = Math.min(MAX_VERSION, o.maxVersion || MAX_VERSION);
    const bytes = toBytes(text);

    let version = -1;
    for (let v = minV; v <= maxV; v++) {
        if (fitsIn(bytes.length, v, ecl)) { version = v; break; }
    }
    if (version < 0) {
        throw new RangeError(`text too long for a version-${maxV} QR code at level ${ecl}`);
    }
    if (o.boostEcl !== false) {
        for (const level of ['M', 'Q', 'H']) {
            if (LEVELS.indexOf(level) > LEVELS.indexOf(ecl) && fitsIn(bytes.length, version, level)) ecl = level;
        }
    }

    const codewords = interleave(buildCodewords(bytes, version, ecl), version, ecl);
    const m = new Matrix(version);
    m.drawFunctionPatterns();
    m.drawCodewords(codewords);

    let mask = Number.isInteger(o.mask) && o.mask >= 0 && o.mask <= 7 ? o.mask : -1;
    if (mask < 0) {
        let best = Infinity;
        for (let i = 0; i < 8; i++) {
            m.applyMask(i);
            m.drawFormatBits(ecl, i);
            const score = m.penalty();
            if (score < best) { best = score; mask = i; }
            m.applyMask(i);   // undo
        }
    }
    m.applyMask(mask);
    m.drawFormatBits(ecl, mask);

    return { version, ecl, mask, size: m.size, modules: m.modules };
}

function escapeXml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

/**
 * Render a symbol as an inline SVG string: one path for every dark module,
 * on a white field with the standard four-module quiet zone. Scales to its
 * container (`width`/`height` in CSS); `crispEdges` keeps the modules square.
 *
 * @param {{size: number, modules: Uint8Array}} qr - from encodeQr
 * @param {object} [opts]
 * @param {number} [opts.margin=4] - quiet zone in modules; do not go below 4
 * @param {string} [opts.label] - accessible name (aria-label)
 * @returns {string}
 */
export function qrSvg(qr, opts) {
    const o = opts || {};
    const margin = Number.isFinite(o.margin) ? Math.max(0, o.margin) : 4;
    const n = qr.size;
    const dim = n + margin * 2;
    let d = '';
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            if (qr.modules[y * n + x]) d += `M${x + margin} ${y + margin}h1v1h-1z`;
        }
    }
    const label = o.label ? ` role="img" aria-label="${escapeXml(o.label)}"` : ' aria-hidden="true"';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"${label}>` +
        `<rect width="${dim}" height="${dim}" fill="#ffffff"/>` +
        `<path d="${d}" fill="#000000"/></svg>`;
}

/**
 * The symbol as text, one character per module — for tests and debugging.
 * @param {{size: number, modules: Uint8Array}} qr
 * @param {string} [dark='██'] @param {string} [light='  ']
 */
export function qrText(qr, dark, light) {
    const D = dark === undefined ? '██' : dark;
    const L = light === undefined ? '  ' : light;
    const rows = [];
    for (let y = 0; y < qr.size; y++) {
        let row = '';
        for (let x = 0; x < qr.size; x++) row += qr.modules[y * qr.size + x] ? D : L;
        rows.push(row);
    }
    return rows.join('\n');
}
