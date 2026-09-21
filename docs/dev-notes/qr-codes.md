# QR codes

Status: shipped — built on branch `qr-codes` 2026-09-19, merged to main 2026-09-20 (2.2.0). Where the codes appear and the encoder's contract are in ARCHITECTURE.md § Share Links and § Invite Codes. This note holds the decisions and how the encoder was verified.

## Decisions

- **Hand-rolled, not vendored.** The app has no build step and already carries two vendored classic scripts. The codes it needs are short URLs (a share link is ~43 bytes, an invite ~40), for which QR versions 1–10 are ample, and a byte-mode encoder for those is about 300 lines in `utils/qrCode.js` that a reviewer can read end to end. Versions 11–40 are deliberately absent: `encodeQr` throws a `RangeError` rather than emit a symbol nothing has tested. If a longer payload ever needs a code, extend the EC table and the alignment positions and re-run the decode test; do not raise `MAX_VERSION` without doing so.
- **Black on white in both themes.** `qrSvg()` writes literal `#000000`/`#ffffff` and a four-module quiet zone into the SVG. A scanner wants a dark code on a light ground and the quiet zone is part of the symbol, so the dark-mode palette does not apply. The CSS token lint only reads stylesheets, so this trips nothing; the dialog CSS sizes and centres the SVG and adds nothing else.
- **Lazy in the share dialog, eager in the invite modal.** A dialog listing several share links renders a code only when its QR button is tapped, but a link that was *just created* opens with its code showing — the coach made it to hand to someone standing right there. The invite modal always shows the code: it exists to hand one code to one person.
- **The QR button's label does not change.** "Hide QR" reflowed the row on a phone; the expanded state is `aria-expanded` plus an orange outline. Below 480 px the share row wraps so the link and expiry keep a full line; the row was already at capacity with two buttons and the third made the URL an ellipsis.
- **Level boosting is on by default.** The smallest version that fits at the requested level is chosen, then the level is raised as far as that version allows for free (spare capacity is worth more as error correction than as padding). A 43-byte share URL therefore lands on version 4 at Q, not M.

## The capacity trap

Byte capacity is not "data codewords × 8 bits". The mode indicator (4 bits) and the character count (8 bits through version 9, 16 from version 10) come out of the same budget, so version 1 at H holds 7 bytes, not 9, and version 3 at M holds 42, not 44 — a 43-byte URL misses v3-M by four bits. The first draft of the unit test assumed the naïve figures and failed on exactly this while the independent decode passed. The test now spells out the real capacities it relies on.

## How it was verified

`tests/unit/qrCode.test.mjs` checks structure (finders, separators, timing, the dark module, format and version BCH remainders), version and level selection, UTF-8 byte counting, a known-answer pin for one fixed symbol, and the SVG's shape. Its last test decodes the encoder's output with `jsqr` (a pure-JS decoder, a devDependency of `tests/` since this branch) for every level, every version 1–10 and every mask, and skips rather than fails when `jsqr` is not installed, so `node --test 'tests/unit/*.test.mjs'` stays dependency-free until you run `npm ci` in `tests/`. The known-answer pin exists so a future change to the encoder is noticed even on a machine without the decoder; if it changes, run the decode test before updating the pin.

`tests/scenarios/16-qr-codes.spec.ts` pins the two dialogs end to end against the test backend: the created link opens its panel with a real symbol for that URL, the button toggles it, and the invite modal carries a code for the invite link.

Real-phone check still worth doing once: scan a share code off a phone in dark mode from a metre away, and an invite code off a laptop screen.
