/**
 * Allowlist for the API-base override (`?api=<url>` and the `ultistats_api_url`
 * localStorage value it writes).
 *
 * WHY THIS EXISTS
 * ---------------
 * `?api=` used to accept any URL, persist it to localStorage, and then
 * `history.replaceState` it out of the address bar. Because `authFetch`
 * attaches `Authorization: Bearer <supabase token>` to whatever base URL it is
 * handed, a single link on the *genuine* production domain —
 *
 *     https://www.breakside.pro/?api=https://evil.example
 *
 * — permanently redirected every authenticated request, on that browser, to an
 * attacker's server: the session token, full rosters, and game state, on every
 * sync, invisibly, until someone happened to type `?api=reset`. The attacker
 * could also serve fabricated responses back.
 *
 * The codebase already had the right instinct for this class of parameter:
 * `?testMode=true` is gated to localhost in two independent places precisely so
 * it "can never become an auth bypass against staging/production". `?api=`
 * simply never got the equivalent.
 *
 * WHAT IS ALLOWED, AND WHY THAT SHAPE
 * -----------------------------------
 * We gate on the override's VALUE rather than on the page's hostname, because
 * the value is what decides where the token goes. That keeps every documented
 * workflow working:
 *
 *   - `?api=http://localhost:8123` against a `scripts/dev-backend.sh` instance
 *     (ARCHITECTURE.md § Local development backends)
 *   - the same override from a **staging** page (CLAUDE.md § Staging deployment)
 *   - `http://192.168.1.100:8000` for multi-device LAN testing — the phone-
 *     against-laptop case the original `store/sync.js` comment describes
 *   - `http://mylaptop.local:8000` (mDNS, the usual macOS spelling of the above)
 *
 * ...while refusing any public host, which is the only kind that can carry a
 * token off the user's own network.
 *
 * Residual, accepted: someone already on your LAN could host a collector at a
 * private address. That is inherent in supporting LAN dev testing at all, and
 * it is a vastly smaller threat than "any link, any attacker, anywhere".
 */

// The one public origin the app is ever allowed to talk to. Keep in sync with
// auth/config.js BREAKSIDE_API_BASE_URL.
const PRODUCTION_API_ORIGINS = ['https://api.breakside.pro'];

// Loopback + RFC1918. Anchored, so `127.0.0.1.evil.example` does not match.
const PRIVATE_IPV4 = /^(?:127|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}$|^192\.168\.\d{1,3}\.\d{1,3}$|^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/;

/** True for hostnames that can only resolve on the loopback interface or a LAN. */
function isPrivateHost(hostname) {
    const h = String(hostname).toLowerCase();
    // URL.hostname keeps the brackets on IPv6 in some engines and drops them
    // in others; accept both spellings of loopback.
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    if (h === '::1' || h === '[::1]') return true;
    if (h.endsWith('.local')) return true;       // mDNS / Bonjour
    return PRIVATE_IPV4.test(h);
}

/**
 * Is `value` acceptable as an API base URL?
 *
 * Rejects non-strings, unparseable values, non-http(s) schemes (`javascript:`,
 * `data:`, `file:`), and every public host except the production API. Note that
 * `new URL()` does the heavy lifting on the nasty spellings: in
 * `http://localhost@evil.example` the hostname is `evil.example`, not
 * `localhost`, so it is correctly refused.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isAllowedApiBase(value) {
    if (typeof value !== 'string' || value === '') return false;

    let url;
    try {
        url = new URL(value);
    } catch {
        return false;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (PRODUCTION_API_ORIGINS.includes(url.origin)) return true;

    return isPrivateHost(url.hostname);
}
