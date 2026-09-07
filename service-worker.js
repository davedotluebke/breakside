const cacheName = 'build-dev';

// The app shell, injected at deploy time by `increment-version.py stamp` from
// the files actually being uploaded — see VERSIONING.md. Empty in the committed
// file, which is correct for local dev (main.js doesn't register a SW on
// localhost at all) and means a stamped deploy is the only way this is non-empty.
//
// Generated rather than hand-listed on purpose. Everything below this line used
// to be populated purely by runtime caching, which meant "does the app work
// offline" depended on whether the user happened to request every asset during
// some online session AFTER the current deploy — each deploy changes cacheName
// and `activate` deletes the old cache. A cold launch could therefore find the
// module graph half-present: index.html paints (it's markup) but main.js never
// runs, so the splash never retracts. That is a real failure that was observed
// on staging, not a hypothetical.
const PRECACHE_URLS = [];

self.addEventListener('install', (e) => {
    console.log('Service Worker: Installed');
    self.skipWaiting(); // Force activation
    e.waitUntil(precacheAppShell());
});

/**
 * Populate the new cache with the app shell before this worker takes over.
 *
 * Deliberately NOT cache.addAll(): that is all-or-nothing, so a single 404 —
 * a CloudFront edge that hasn't caught up with the deploy yet, one stale entry
 * in a generated manifest — would reject the whole install and leave the app
 * with NO precache at all. Per-URL adds degrade instead: whatever fetched is
 * cached, the rest falls back to runtime caching, and the count is logged so a
 * systematically broken manifest is visible rather than silent.
 *
 * `cache: 'reload'` so we store what the server has right now rather than
 * whatever the browser's HTTP cache is still holding from the previous build.
 */
async function precacheAppShell() {
    if (!PRECACHE_URLS.length) return;
    const cache = await caches.open(cacheName);
    const results = await Promise.allSettled(
        PRECACHE_URLS.map(url => cache.add(new Request(url, { cache: 'reload' })))
    );
    const failed = results
        .map((r, i) => (r.status === 'rejected' ? PRECACHE_URLS[i] : null))
        .filter(Boolean);
    console.log(
        `Service Worker: precached ${results.length - failed.length}/${results.length}`,
        failed.length ? `— failed: ${failed.join(', ')}` : '');
}

self.addEventListener('activate', (e) => {
    console.log('Service Worker: Activated');
    // Take control of all clients immediately
    e.waitUntil(clients.claim());
    
    // Remove unwanted caches
    e.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cache => {
                    if (cache !== cacheName) {
                        console.log('Service Worker: Clearing old cache');
                        return caches.delete(cache);
                    }
                })
            );
        })
    );
});

self.addEventListener('fetch', e => {
    // Only cache GET requests
    if (e.request.method !== 'GET') {
        return;
    }

    let requestUrl;
    try {
        requestUrl = new URL(e.request.url);
    } catch (_) {
        return;  // non-parseable URL — let the browser handle it untouched
    }

    // Don't cache API calls. Match by path prefix (covers same-origin /api/* and
    // any dev backend, e.g. dev-backend.sh's :8001+ ports) plus the known API
    // hosts — robust where the old substring host/port matching was not.
    const API_HOSTS = ['api.breakside.pro', 'api.breakside.us'];
    if (requestUrl.pathname.startsWith('/api/') || API_HOSTS.includes(requestUrl.hostname)) {
        return;
    }

    const isSameOrigin = requestUrl.origin === self.location.origin;

    // For our OWN (largely unversioned) assets, bypass the browser HTTP cache on
    // the network attempt so a redeploy is picked up immediately instead of the
    // browser handing back a stale cached landing.css/logo/etc. Cross-origin CDN
    // assets (Google Fonts, Supabase, Font Awesome) keep their normal caching.
    const networkFetch = isSameOrigin
        ? fetch(reloadRequest(e.request))
        : fetch(e.request);

    const networkFirst = withTimeout(networkFetch)
        .then(networkResponse => {
            // Only cache successful, same-origin GET responses. Caching
            // error responses (404/500) or opaque cross-origin responses
            // would let stale/invalid content be served offline as valid.
            if (isSameOrigin && networkResponse && networkResponse.ok) {
                const responseClone = networkResponse.clone();
                caches.open(cacheName)
                    .then(cache => {
                        cache.put(e.request, responseClone);
                    });
            }
            return networkResponse;
        });

    if (isSameOrigin && e.request.mode === 'navigate') {
        // A NAVIGATION (address bar, a tapped link, a home-screen launch) is
        // always answered by the app shell: this is a single-page app, so
        // any in-scope path — including ones that exist only as an S3 404
        // fallback, like /view/<hash> share links — boots index.html and
        // routes from there. So when the network fails or times out, fall
        // back to the precached shell rather than to a cached copy of that
        // exact URL, which never exists for a fresh path. Before this, an
        // installed PWA opening a share link from Messages on a slow cold
        // start died with "no cached response found" (2026-09-02).
        e.respondWith(
            networkFirst.catch(() => matchFirst([e.request, '/index.html', '/'])
                .then(hit => hit || Promise.reject('No cached app shell')))
        );
        return;
    }

    e.respondWith(
        networkFirst.catch(() => {
            // If network fails or times out, try cache
            return caches.match(e.request)
                .then(cacheResponse => {
                    return cacheResponse || Promise.reject('No cached response found');
                });
        })
    );
});

const NETWORK_TIMEOUT_MS = 5000;

/** The network attempt, abandoned after NETWORK_TIMEOUT_MS. */
function withTimeout(promise) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Timeout')), NETWORK_TIMEOUT_MS);
        }),
    ]);
}

/**
 * A copy of `request` that bypasses the browser HTTP cache. Built up front
 * (not via fetch(request, init)) and guarded: some engines refuse to derive
 * a new Request from a navigation request with a non-empty init, and a
 * synchronous TypeError there would reject the whole network attempt before
 * it started. Falling back to the original request costs only freshness.
 */
function reloadRequest(request) {
    try {
        return new Request(request, { cache: 'reload' });
    } catch (_) {
        return request;
    }
}

/** The first cache hit among `keys` (Request objects or URL strings), else undefined. */
function matchFirst(keys) {
    return keys.reduce(
        (chain, key) => chain.then(hit => hit || caches.match(key)),
        Promise.resolve(undefined));
}