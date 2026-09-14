const CACHE = 'dash-v2';

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      c.addAll(['/', '/index.html', '/app.js', '/styles.css'])
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const isData = /^\/data\/.*\.json(\.gz)?$/.test(url.pathname);
  const isAccess = /\/access\.json$/.test(url.pathname);

  if (isAccess) {
    // Login config must always be fresh — never serve a stale copy
    const key = new Request(url.origin + url.pathname);
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res.ok) caches.open(CACHE).then((cache) => cache.put(key, res.clone())).catch(() => {});
        return res;
      }).catch(() => caches.match(key))
    );
  } else if (isData) {
    // Data files: stale-while-revalidate
    // Use base URL (no query params) as cache key
    const key = new Request(url.origin + url.pathname);
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(key);
        if (cached) {
          // return cached instantly, refresh cache in background
          fetch(e.request).then((res) => {
            if (res.ok) cache.put(key, res);
          }).catch(() => {});
          return cached;
        }
        // no cache — fetch fresh
        return fetch(e.request).then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        });
      })
    );
  } else {
    // Static assets: stale-while-revalidate so new deploys propagate automatically
    const key = new Request(url.origin + url.pathname);
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(key);
        if (cached) {
          // return cached instantly, refresh cache in background
          fetch(e.request).then((res) => {
            if (res.ok) cache.put(key, res);
          }).catch(() => {});
          return cached;
        }
        // no cache — fetch fresh
        return fetch(e.request).then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        });
      })
    );
  }
});
