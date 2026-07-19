/*
 * authFetch core — authenticated fetch with 401-retry, extracted as a pure
 * factory so it can be unit-tested (pattern: store/pendingLineLogic.js;
 * tests/unit/authFetchLogic.test.mjs pins the behavior).
 *
 * History: pre-ESM there were two same-named authFetch globals; auth/auth.js's
 * had 401-retry resilience (B2: stale-bearer 401s on long sideline sessions)
 * but was shadowed dead code — store/sync.js's simpler version overwrote it at
 * load time — and was deleted at C8 to preserve runtime behavior. G4 ports the
 * retry semantics here, into the one surviving implementation, so every caller
 * gets them.
 *
 * makeAuthFetch(deps) returns an async (url, options) → Response that:
 *   - forces 'Content-Type: application/json' (callers cannot override — the
 *     surviving sync.js behavior, preserved);
 *   - attaches 'Authorization: Bearer <token>' when deps.getToken() yields one
 *     (test mode yields none, so test-mode requests are untouched);
 *   - on a 401 *with* a token attached: forces one session refresh — shared
 *     across concurrent 401s (single-flight) so simultaneous failures don't
 *     stampede Supabase — and retries exactly once with the fresh token. The
 *     retry's response is returned even if it is also a 401;
 *   - never retries more than once per call (no loops), and never retries
 *     when the request was anonymous, when refresh yields nothing, or when
 *     options.body is a ReadableStream (a consumed stream can't be replayed;
 *     the string/FormData/Blob bodies all callers use replay fine);
 *   - returns the original 401 response if the retry fetch itself throws
 *     (a completed round-trip shouldn't turn into a rejection — matches the
 *     pre-C8 variant).
 *
 * deps contract (all late-bound, called per request):
 *   fetchFn(url, init) → Promise<Response>
 *   getToken() → Promise<string|null> — current access token; must resolve
 *       null rather than reject when auth is unavailable (caller wraps).
 *   forceRefreshToken() → Promise<string|null> — force-refreshed access
 *       token, or null when refresh is unavailable/failed (signed out, test
 *       mode, Supabase down). Rejections are caught and treated as null.
 *   getExtraHeaders() → Promise<object> — identity headers that are not the
 *       bearer (today: X-Test-User-Id in test mode). Without this, test-mode
 *       pages send NO identity at all and an auth-disabled backend maps every
 *       request to its default test user — which silently broke per-page
 *       identities (?testUserId=...) for multi-coach testing. Resolved once
 *       per call and reused for the retry. Rejections are treated as {}.
 *   warn(...args) — non-fatal diagnostics sink (console.warn in the app).
 */

export function makeAuthFetch({ fetchFn, getToken, forceRefreshToken, getExtraHeaders = async () => ({}), warn = () => {} }) {
    // Single-flight refresh guard: when several in-flight requests all 401
    // (typical after sleep/wake with an expired token), they share one
    // refresh promise instead of each calling refreshSession() concurrently.
    let refreshInFlight = null;

    function refreshOnce() {
        if (!refreshInFlight) {
            refreshInFlight = Promise.resolve()
                .then(forceRefreshToken)
                .catch((e) => {
                    warn('401 retry: session refresh failed:', e);
                    return null;
                })
                .finally(() => { refreshInFlight = null; });
        }
        return refreshInFlight;
    }

    return async function authFetchCore(url, options = {}) {
        let extraHeaders = {};
        try {
            extraHeaders = (await getExtraHeaders()) || {};
        } catch (e) {
            warn('authFetch: getExtraHeaders failed, continuing without:', e);
        }

        const buildInit = (token) => {
            const headers = {
                ...extraHeaders,
                ...options.headers,
                'Content-Type': 'application/json',
            };
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }
            return { ...options, headers };
        };

        const token = (await getToken()) || null;
        let response = await fetchFn(url, buildInit(token));

        // Retry once on 401 with a freshly-refreshed token: getSession() can
        // hand back a stale cached token that the server rejects (long
        // sideline session, clock skew). A forced refresh + single retry
        // recovers transparently. Anonymous requests (no token attached)
        // 401 for other reasons — never retry those.
        const bodyReplayable =
            typeof ReadableStream === 'undefined' ||
            !(options.body instanceof ReadableStream);
        if (response.status === 401 && token && bodyReplayable) {
            try {
                const freshToken = await refreshOnce();
                if (freshToken && freshToken !== token) {
                    response = await fetchFn(url, buildInit(freshToken));
                }
            } catch (e) {
                // The retry fetch threw (e.g. network dropped mid-retry):
                // fall back to the original 401 response.
                warn('401 retry failed; returning original response:', e);
            }
        }

        return response;
    };
}
