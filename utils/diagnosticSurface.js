/*
 * Where developer diagnostics may be shown.
 *
 * The battery report is a wall of counters aimed at whoever is tuning the
 * polling loops. A coach on a sideline should never meet it, so the rule is an
 * ALLOWLIST rather than "hide it on production".
 *
 * That distinction is the whole point of this file. A denylist fails OPEN: the
 * first time the app is served from an origin nobody anticipated — a preview
 * host, a copied bucket, a custom domain, someone's LAN IP — a
 * `hostname !== 'www.breakside.pro'` check quietly starts showing diagnostics
 * to real users. An allowlist fails CLOSED, which is the direction a "users
 * must never see this" requirement has to fail in.
 *
 * Pure leaf module: no DOM, no imports, no globals read. The caller passes the
 * hostname and the staging flag in, so this can be unit-tested against every
 * origin that matters — including the ones we don't have.
 */

/**
 * @param {string} hostname - `location.hostname` ('' for file://)
 * @param {boolean} isStaging - `window._isStaging`, set inline by index.html
 * @returns {boolean} true only on a known developer surface
 */
export function isDiagnosticHost(hostname, isStaging) {
    if (isStaging === true) return true;

    // Local development, including a build opened straight off disk (file://,
    // which reports an empty hostname).
    const host = String(hostname ?? '');
    return host === 'localhost'
        || host === '127.0.0.1'
        || host === '[::1]'
        || host === '::1'
        || host === '';
}
