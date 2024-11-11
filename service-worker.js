const cacheName = 'v1';

self.addEventListener('install', (e) => {
    console.log('Service Worker: Installed');
});

self.addEventListener('activate', (e) => {
    console.log('Service Worker: Activated');
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
    console.log('Service Worker: Fetching');
    e.respondWith(
        Promise.race([
            // Try network first
            fetch(e.request)
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