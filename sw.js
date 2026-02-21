const CACHE_NAME = 'cedvel-km-v2';
const LOCAL_ASSETS = [
    './cedvel.html',
    './herkes.html',
    './firestore_manager.js',
    './site.webmanifest',
    './favicon.png',
    'https://cdn.tailwindcss.com',
    'https://unpkg.com/@phosphor-icons/web'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // Hər faylı tək-tək yükləyirik ki, 404 xətası yaranarsa bütün faza dayanmasın
            return Promise.allSettled(
                LOCAL_ASSETS.map(url => cache.add(url).catch(err => console.warn(`Cache failed for ${url}:`, err)))
            );
        }).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (!cacheWhitelist.includes(cacheName)) {
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    if (event.request.url.includes('firestore.googleapis.com') || event.request.url.includes('firebase')) {
        return;
    }
    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                return cachedResponse;
            }
            return fetch(event.request).then((networkResponse) => {
                if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic' && networkResponse.type !== 'cors') {
                    return networkResponse;
                }
                const clonedResponse = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, clonedResponse);
                });
                return networkResponse;
            }).catch(() => { });
        })
    );
});
