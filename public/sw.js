/* Cozy Coaster service worker.
 * - Precaches the exact asset list of the build it ships with (precache-manifest.json), so an
 *   engine and its assets always come from the same version (no stale mixes).
 * - Navigations are network-first with an offline fallback to the cached app shell.
 * - Hashed assets are cache-first (immutable).
 * - A new version installs in the background and only activates when the page asks.
 */
const PREFIX = 'cozy-coaster-';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const res = await fetch('/precache-manifest.json', { cache: 'no-store' });
      const { version, assets } = await res.json();
      const cache = await caches.open(PREFIX + version);
      const urls = ['/', ...assets.filter((a) => !a.endsWith('.map') && a !== 'precache-manifest.json').map((a) => '/' + a)];
      await cache.addAll(urls);
      await cache.put('/__version', new Response(version));
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Keep only the newest cache (the one holding this worker's version).
      let current = null;
      for (const k of keys) {
        if (!k.startsWith(PREFIX)) continue;
        const c = await caches.open(k);
        if (await c.match('/__version')) current = current && current > k ? current : k;
      }
      await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== current).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          const cached = await caches.match('/');
          return cached || new Response('Offline', { status: 503 });
        }
      })(),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) {
          const keys = (await caches.keys()).filter((k) => k.startsWith(PREFIX)).sort();
          const name = keys[keys.length - 1];
          if (name) (await caches.open(name)).put(req, res.clone());
        }
        return res;
      })(),
    );
  }
});
