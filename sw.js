/* BlockFit service worker – network-first.
   Online: always fetch fresh files (bypassing the browser's HTTP cache) and keep a copy.
   Offline: fall back to the last copy that was saved.
   Weather/geocoding requests (Open-Meteo) are never cached. */
'use strict';

const CACHE = 'blockfit-v1';   // bump this if you ever want to force-clear old copies

const CORE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      // add files one by one so a single missing file (e.g. an icon) doesn't break install
      .then(cache => Promise.allSettled(CORE.map(url => cache.add(new Request(url, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // Only handle our own files and the Google Fonts; let everything else (weather API) go straight to the network.
  if (!sameOrigin && !FONT_HOSTS.includes(url.hostname)) return;

  event.respondWith(networkFirst(req, sameOrigin));
});

async function networkFirst(req, sameOrigin) {
  const cache = await caches.open(CACHE);
  try {
    // 'no-cache' = ask the server if the file changed, so GitHub Pages' 10-minute cache can't serve stale files
    const res = await fetch(req, sameOrigin ? { cache: 'no-cache' } : undefined);
    if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = (await cache.match('./index.html')) || (await cache.match('./'));
      if (shell) return shell;
    }
    return Response.error();
  }
}
