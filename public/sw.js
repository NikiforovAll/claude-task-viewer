const CACHE_NAME = 'cc-kanban-v1';
const PRECACHE_URLS = ['/'];

let cachePromise = null;
function getCache() {
  if (!cachePromise) cachePromise = caches.open(CACHE_NAME);
  return cachePromise;
}

function cacheResponse(request, response) {
  if (response.ok) {
    getCache().then(cache => cache.put(request, response.clone()));
  }
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    getCache()
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  cachePromise = null;
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls or SSE streams
  if (url.pathname.startsWith('/api')) return;

  // Network-first for same-origin, fallback to cache
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then(r => cacheResponse(event.request, r))
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // CDN resources: cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(r => cacheResponse(event.request, r));
    })
  );
});
