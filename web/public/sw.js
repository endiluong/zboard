// ZBoard service worker. The build stamps VERSION and SHELL (see vite.config.js),
// so every new build gets a new shell cache and replaces the old one on next load.
const VERSION = '__ZB_VERSION__';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png'].concat(/*__ZB_SHELL__*/ []);
const SHELL_CACHE = 'zb-shell-' + VERSION;
const IMAGE_CACHE = 'zb-images-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('zb-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// `key` lets retries (?r=1, added by the page after a dropped request) share one cache entry.
// A request that fails outright (a weak mobile signal) is tried once more before giving up.
async function cacheFirst(cacheName, req, key = req) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(key);
  if (hit) return hit;
  let res;
  try {
    res = await fetch(req);
  } catch {
    await new Promise((r) => setTimeout(r, 800));
    res = await fetch(req);
  }
  if (res.ok) cache.put(key, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Live data always goes to the network.
  if (url.pathname.startsWith('/api/')) return;
  // Previews (every size) never change for a given id and ?v (a PDF's or video's preview, which a
  // browser may draw again, carries ?v=<width>x<height>; ?r=, a retry, is left out of the key).
  if (/^\/files\/[^/]+\/(thumb|mini|micro)$/.test(url.pathname)) {
    const v = url.searchParams.get('v');
    e.respondWith(cacheFirst(IMAGE_CACHE, req, url.pathname + (v ? '?v=' + v : '')));
    return;
  }
  if (url.pathname.startsWith('/files/')) return;
  // Pages: the shell this worker installed opens at once (no wait on a slow network before the boot
  // intro can draw). It always matches this build's scripts; a new build brings a new worker, which
  // the browser picks up in the background and uses from the next start.
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('/', { cacheName: SHELL_CACHE }).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) caches.open(SHELL_CACHE).then((c) => c.put('/', res.clone()));
            return res;
          })
      )
    );
    return;
  }
  // The app's startup files, plus parts loaded on demand (the PDF reader, pdf.js and its worker,
  // fonts some PDFs need): kept after their first use, so a PDF opens offline the next time too.
  if (SHELL.includes(url.pathname) || url.pathname.startsWith('/assets/') || url.pathname.startsWith('/pdfjs/')) e.respondWith(cacheFirst(SHELL_CACHE, req));
});
