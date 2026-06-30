const cacheName = 'build-254';

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

    // Don't cache API calls
    if (e.request.url.includes(':8000/') || 
        e.request.url.includes('api.breakside.pro') ||
        e.request.url.includes('api.breakside.us')) {
        return;
    }

    // For our OWN (largely unversioned) assets, bypass the browser HTTP cache on
    // the network attempt so a redeploy is picked up immediately instead of the
    // browser handing back a stale cached landing.css/logo/etc. Cross-origin CDN
    // assets (Google Fonts, Supabase, Font Awesome) keep their normal caching.
    const sameOrigin = e.request.url.startsWith(self.location.origin);
    const networkFetch = sameOrigin
        ? fetch(e.request, { cache: 'reload' })
        : fetch(e.request);

    e.respondWith(
        Promise.race([
            // Try network first
            networkFetch
                .then(networkResponse => {
                    // Clone the response before caching it
                    const responseClone = networkResponse.clone();
                    caches.open(cacheName)
                        .then(cache => {
                            cache.put(e.request, responseClone);
                        });
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