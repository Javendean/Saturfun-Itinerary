// Saturfun unified service worker (root scope /Saturfun-Itinerary/).
// Network-first for the app shell (fresh after deploy) + cache fallback (offline).
// Handles ONLY same-origin shell paths; passes through everything else — including
// all cross-origin calls to saturfun-worker (never caches /api/*).
const CACHE = "saturfun-app-v6";
const SHELL = [
  "index.html", "wall.html", "manga.html", "panels.html", "plan.html",
  "tokens.css", "app-shell.css", "app-shell.js",
  "wall.css", "wall.js",
  "saturfun.webmanifest",
  "wall-icon-192.png", "wall-icon-512.png", "wall-icon-maskable.png", "wall-apple-touch-icon.png",
];
const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, self.location).pathname));
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !SHELL_PATHS.has(url.pathname)) return; // pass-through
  e.respondWith(
    fetch(req, { cache: "reload" })
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res; })
      .catch(() => caches.match(req).then((m) => m || caches.match(new URL("index.html", self.location).pathname)))
  );
});
self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let title = "Saturfun", body = "You have something new.", url = "plan.html";
    try {
      const r = await fetch("https://saturfun-worker.javendean.workers.dev/api/push/digest", { cache: "no-store" });
      if (r.ok) { const d = await r.json(); if (d && d.body) { title = d.title || title; body = d.body; url = d.url || url; } }
    } catch (_) { /* offline → generic notification below */ }
    await self.registration.showNotification(title, { body, icon: "wall-icon-192.png", badge: "wall-icon-192.png", data: { url } });
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "plan.html";
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const scope = new URL("./", self.location).href;
    for (const c of all) { if (c.url.startsWith(scope) && "focus" in c) { await c.focus(); if ("navigate" in c) { try { await c.navigate(scope + target); } catch (_) {} } return; } }
    await self.clients.openWindow(scope + target);
  })());
});
