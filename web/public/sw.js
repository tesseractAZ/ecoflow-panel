/**
 * Minimal service worker for EcoFlow Panel PWA.
 *
 * Strategy:
 *   - Static assets (HTML, JS, CSS, images): stale-while-revalidate.
 *   - API requests (/api/* anywhere in the path, /ws): NEVER cached.
 *
 * v0.9.5 — the API-detection regex now matches `/api/` anywhere in the
 * pathname (not just the start) so live data bypasses cache both on
 * direct LAN (:8787/api/...) and under HA Ingress
 * (/api/hassio_ingress/<token>/api/...). Without this, requests through
 * Ingress would be served from cache instead of hitting the live add-on.
 */
const CACHE = 'ecoflow-panel-v0.9.5';
// No pre-cached static assets — let the SW lazily cache whatever the page
// actually fetches. Avoids `caches.addAll` failing when running under a
// subpath (the absolute '/' wouldn't match the ingress mount point).
const STATIC_ASSETS = [];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Live data — bypass cache entirely. Match `/api/...` anywhere in the
  // path AND any URL ending in `/ws` (websocket upgrade). Catches both
  // direct LAN (/api/snapshot, /ws) and Ingress
  // (/api/hassio_ingress/<token>/api/snapshot, .../ws).
  if (/\/api\//.test(url.pathname) || /\/ws$/.test(url.pathname)) return;
  // Static — stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(event.request).then((cached) => {
        const network = fetch(event.request)
          .then((response) => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || network;
      }),
    ),
  );
});
