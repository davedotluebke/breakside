/**
 * Deep links into the signed-in app: `/?open=<screen>&team=<id>`.
 *
 * The server mints them (a held-mail notice sends a coach straight to the
 * team's Email Lists, breakside_server/mail/relay.py review_url) and
 * main.js reads one at boot: it stashes the link in sessionStorage so it
 * survives the landing-page sign-in round trip, strips it from the address
 * bar, and opens the screen once the team list is up.
 *
 * Pure: no DOM, no storage. Unknown screens and malformed ids parse as no
 * link at all, so a hostile or stale query can only ever land on the Teams
 * screen. Compare utils/apiOrigin.js for why a query parameter is validated
 * before it is acted on.
 */

// Screens a link may open, by the `open` value.
const SCREENS = new Set(['mail']);

// {sanitized-name}-{4-char-hash} (store/models.js generateShortId): letters,
// digits and hyphens only.
const TEAM_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * @param {string} search - `location.search` (with or without the `?`)
 * @returns {{screen: string, teamId: string}|null}
 */
export function parseDeepLink(search) {
    const params = new URLSearchParams(search || '');
    const screen = params.get('open');
    const teamId = params.get('team');
    if (!screen || !SCREENS.has(screen)) return null;
    if (!teamId || !TEAM_ID.test(teamId)) return null;
    return { screen, teamId };
}

/**
 * The query string with the deep-link keys removed and every other key
 * kept (a dev `?api=` override, say): '' or '?rest=of&the=query'.
 */
export function stripDeepLink(search) {
    const params = new URLSearchParams(search || '');
    params.delete('open');
    params.delete('team');
    const rest = params.toString();
    return rest ? `?${rest}` : '';
}
