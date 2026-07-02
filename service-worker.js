const cacheName = 'build-270';

self.addEventListener('install', (e) => {
    console.log('Service Worker: Installed');
    self.skipWaiting(); // Force activation
});

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

    console.log('Service Worker: Fetching', e.request.url);
    e.respondWith(
        Promise.race([
            // Try network first
            fetch(e.request)
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
                }),
            // Timeout after 5 seconds
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error('Timeout')), 5000);
            })
        ])
        .catch(() => {
            // If network fails or times out, try cache
            return caches.match(e.request)
                .then(cacheResponse => {
                    return cacheResponse || Promise.reject('No cached response found');
                });
        })
    );
});