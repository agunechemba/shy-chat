// ════════════════════════════════════════════════════════
//  shy-chat — service worker
//  Caches the app shell. NEVER touches API calls or POSTs.
// ════════════════════════════════════════════════════════

// ── BUMP THIS ON EVERY DEPLOY THAT CHANGES CACHED FILES ──
const CACHE_VERSION = 'v1';
const CACHE_NAME    = 'shychat-' + CACHE_VERSION;

const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon.svg',
];

// ── INSTALL ─────────────────────────────────────────────
// First install auto-activates (no old SW to wait for).
// On update, the new SW waits until the client sends SKIP_WAITING.
self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Cache each URL individually so a missing PNG doesn't break install.
      await Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[sw] cache miss:', url, err);
          })
        )
      );
    })()
  );
});

// ── ACTIVATE ────────────────────────────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// ── MESSAGE (from the page) ─────────────────────────────
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── FETCH ───────────────────────────────────────────────
self.addEventListener('fetch', (e) => {
  const req = e.request;

  // Only handle same-origin GETs. Everything else (API calls,
  // POSTs, cross-origin) passes through untouched.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // ── Navigation (HTML): network-first, cached fallback
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached =
            (await caches.match(req)) ||
            (await caches.match('./index.html')) ||
            (await caches.match('./'));
          return cached || new Response('Offline', { status: 503 });
        })
    );
    return;
  }

  // ── Assets: stale-while-revalidate
  e.respondWith(
    (async () => {
      const cached = await caches.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => null);
      return cached || (await network) || new Response('', { status: 504 });
    })()
  );
});