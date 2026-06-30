// Photo Wall service worker.
//
// SCOPE SAFETY: registered with scope "wall" (see wall.js), so this SW controls ONLY
// the wall's own pages (prefix /…/wall*) — index.html and the rest of the Saturfun
// site are never controlled. The wall page's own subresources + the Worker API still
// hit the fetch handler; we intercept only the wall shell and pass everything else
// straight to the network by not calling respondWith().
//
// BUMP `CACHE` on every wall deploy: it byte-changes this script (so the browser
// installs the new shell) and namespaces caches so old ones are purged on activate.
//
// To reset on a device: DevTools → Application → Service Workers → Unregister, and
// clear the "saturfun-wall-*" cache.

const CACHE = "saturfun-wall-v7";
const SHELL = [
  "wall.html",
  "wall.css",
  "wall.js",
  "wall.webmanifest",
  "wall-icon-192.png",
  "wall-icon-512.png",
  "wall-icon-maskable.png",
];
// Resolve the shell to absolute pathnames once, against this SW script's URL.
const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, self.location).pathname));

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return; // uploads/deletes etc. → never touch
  const url = new URL(req.url);
  // Only our own origin AND only the wall shell. Anything else → default network fetch.
  if (url.origin !== self.location.origin || !SHELL_PATHS.has(url.pathname)) return;
  // Network-first with HTTP-cache BYPASS (cache:"reload") so a deploy is picked up
  // immediately, not after GitHub Pages' ~10-min asset cache. Cache fallback = offline shell.
  e.respondWith(
    fetch(req, { cache: "reload" })
      .then((res) => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req)),
  );
});
