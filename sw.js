// Caches just the static app shell (HTML/CSS/JS) so the UI still loads offline.
// All actual data (coins, prices, balances) comes from Firestore's own offline
// persistence layer (enabled in script.js) — this worker only exists to make sure
// the page itself can open without a network connection.
const CACHE_NAME = 'degen-shell-v1';
const SHELL_FILES = ['./', './index.html', './style.css', './script.js', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Only handle same-origin GET requests for the app shell itself — never intercept
  // Firestore/Firebase/CDN traffic, which needs to hit the network (or fail fast so
  // the SDK's own offline queueing can take over).
  if(req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if(res && res.status===200){
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
