/**
 * Parse what a coach typed into an "email(s)" field on the Email Lists screen.
 *
 * Pure: no DOM, so it is unit-tested directly (tests/unit/mailAddressInput.test.mjs).
 * Mirrors the server's rule (storage/mail_storage.py `_clean_emails`) — split
 * on commas, semicolons and whitespace; lowercase; dedupe; keep order — so the
 * screen can warn about a malformed entry before the request instead of
 * after a 400.
 */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * @param {string} text  Raw field contents.
 * @returns {{valid: string[], invalid: string[], normalized: string}}
 *   `valid` are lowercased, deduplicated addresses in the order typed;
 *   `invalid` are the entries that are not shaped like an address, as typed;
 *   `normalized` is `valid` joined with ", " — what the field should show.
 */
export function parseEmailList(text) {
    const valid = [];
    const invalid = [];
    for (const raw of String(text ?? '').split(/[,;\s]+/)) {
        const part = raw.trim();
        if (!part) continue;
        const lower = part.toLowerCase();
        if (!EMAIL_RE.test(lower)) {
            if (!invalid.includes(part)) invalid.push(part);
            continue;
        }
        if (!valid.includes(lower)) valid.push(lower);
    }
    return { valid, invalid, normalized: valid.join(', ') };
}
