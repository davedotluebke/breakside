const cacheName = 'v19';

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

    console.log('Service Worker: Fetching', e.request.url);
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