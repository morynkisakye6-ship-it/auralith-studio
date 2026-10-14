/* Tapehead Pro service worker — network-first shell with offline fallback */
const CACHE = 'tapehead-v11215-studio-features';
// The Supabase SDK comes from a CDN as an opaque cross-origin script, which the generic handler below never
// caches (opaque responses are not `ok`). Without it the app falls back to "Local mode" when launched offline.
const CDN_CACHE = 'tapehead-cdn-v1';
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/dist/umd/supabase.min.js';
const LAME_URL = 'https://cdnjs.cloudflare.com/ajax/libs/lamejs/1.2.1/lame.min.js';   // MP3 encoder, loaded on demand by js/mp3.js
const CDN_URLS = [SDK_URL, LAME_URL];
const SHELL = [
  './index.html',
  './app.js?v=1.12.15-studio-features',
  './js/state.js?v=1.11.0-mod',
  './js/cloud.js?v=1.11.0-mod',
  './js/dsp.js?v=1.12.15',
  './js/midi.js?v=1.12.15',
  './js/mp3.js?v=1.12.15',
  './js/continuity.js?v=1.11.0-mod',
  './cloud-config.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(Promise.all([
    // Add files one by one: cache.addAll() is all-or-nothing, so a single missing asset (e.g. an icon) would
    // silently disable the entire offline shell.
    caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(u).catch((err) => console.warn('[SW] precache skipped', u, err && err.message))))),
    // Warm the SDK cache at install time so the very first offline launch works.
    caches.open(CDN_CACHE).then((c) => Promise.all(CDN_URLS.map((u) => fetch(u, { mode: 'no-cors' }).then((r) => c.put(u, r)).catch(() => {}))))
  ]));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE && k !== CDN_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request, { cache: 'no-store' }));
    return;
  }

  // Pinned, immutable SDK: cache-first (opaque responses are fine for <script>), refresh in the background.
  if (CDN_URLS.includes(url.href)) {
    e.respondWith(
      caches.open(CDN_CACHE).then(async (c) => {
        const hit = await c.match(e.request.url);
        if (hit) return hit;
        try {
          const res = await fetch(e.request);
          if (res && (res.ok || res.type === 'opaque')) c.put(e.request.url, res.clone()).catch(() => {});
          return res;
        } catch (err) { return Response.error(); }
      })
    );
    return;
  }

  const isShell =
    e.request.mode === 'navigate' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('sw.js') ||
    url.pathname.endsWith('cloud-config.js') ||
    url.pathname.endsWith('manifest.webmanifest') ||
    url.pathname.includes('/js/');

  if (isShell) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' })
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() =>
          caches.match(e.request).then((hit) =>
            hit || (e.request.mode === 'navigate' ? caches.match('./index.html') : undefined) || Response.error()
          )
        )
    );
    return;
  }

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
