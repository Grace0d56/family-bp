/* Network-first cache for the app shell. All URLs remain relative for GitHub project Pages. */
const CACHE_NAME = 'family-bp-shell-github-pages-v3';
const SHELL = [
  './', './index.html', './styles.css', './config.js', './api.js', './app.js',
  './manifest.webmanifest', './favicon.svg', './icon-192.png', './icon-512.png'
];
const ALLOWED = new Set(SHELL.map(path => new URL(path, self.registration.scope).pathname));

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key.startsWith('family-bp-shell-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // Do not intercept Supabase or non-GET requests; never cache private API responses.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!ALLOWED.has(url.pathname)) return;

  event.respondWith(
    fetch(request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }).catch(async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const home = await caches.match('./index.html');
        if (home) return home;
      }
      return Response.error();
    })
  );
});
