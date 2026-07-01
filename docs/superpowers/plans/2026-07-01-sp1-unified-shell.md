# SP1 — Unified PWA Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. No frontend test framework — verify via `node --check`, structural greps, and live browser (chrome-devtools).

**Goal:** Turn the 4 standalone pages into one installable dark PWA with a shared bottom tab bar, one service worker, and one manifest.

**Architecture:** Multi-page app. A shared shell (`tokens.css` + `app-shell.css` + `app-shell.js`) is injected into every page; `app-shell.js` renders the bottom tab bar, marks the active tab, registers ONE root `sw.js` (and migrates off the old wall SW). `index.html` is re-themed light→dark via the shared tokens. Served on GitHub Pages at `/Saturfun-Itinerary/`.

**Tech Stack:** vanilla JS/CSS (no build), one root service worker, one web manifest. Deployed to `main` + `gh-pages`.

## Global Constraints
- Dark theme only: ink `#0E0E10` / paper `#F2EFE9` / blood `#B33A3A` / gold `#D4AF37` / muted `#5A5A5A` / card `#161618`; Playfair Display + Inter.
- The unified `sw.js` must ONLY handle same-origin shell paths and PASS THROUGH everything else — especially cross-origin calls to `saturfun-worker.javendean.workers.dev` (never cache `/api/*`). Same guard as `wall-sw.js` (`url.origin !== self.location.origin || !SHELL_PATHS.has(url.pathname) → return`).
- Do NOT break existing wall features (reactions, comments, whirlwind, haptics, refresh, upload).
- The tab bar is fixed at the bottom; every page must reserve `padding-bottom` so content isn't hidden behind it.
- Bump `sw.js` `CACHE` on every deploy; push `main` + `gh-pages`.
- Reuse the existing `wall-icon-192/512/maskable.png` + `wall-apple-touch-icon.png` as the app icons (on-brand Sacred Heart) — no new icons this SP.
- Frontend has no unit tests; each task verifies via `node --check`, greps for required symbols, and the final task does live browser verification.

## File Structure
- Create `tokens.css` — shared dark design tokens (`:root` custom properties) + a small base reset.
- Create `app-shell.css` — bottom tab-bar styles + `--tab-bar-h` + a `.has-tabbar` padding helper.
- Create `app-shell.js` — renders the tab bar, marks active tab, registers root `sw.js`, unregisters the old wall SW.
- Create `sw.js` — unified root service worker (network-first shell, pass-through everything else).
- Create `saturfun.webmanifest` — unified manifest.
- Create `plan.html` — minimal placeholder for the Plan tab (filled in by SP3/SP4).
- Modify `index.html`, `wall.html`, `manga.html`, `panels.html` — inject shell head + script + bottom padding; retire wall's own PWA wiring.
- Modify `wall.js` — remove its `wall-sw.js` registration (app-shell registers the root SW).

---

### Task 1: Shared tokens + app-shell (tab bar + SW registration)

**Files:** Create `tokens.css`, `app-shell.css`, `app-shell.js`.

**Interfaces:**
- Produces: a global stylesheet of dark tokens; a fixed bottom tab bar auto-injected on DOMContentLoaded; root SW registration + old-SW migration. Tabs: Trip→`index.html`, Wall→`wall.html`, Panels→`manga.html` (also active on `panels.html`), Plan→`plan.html`.

- [ ] **Step 1: `tokens.css`**
```css
/* Saturfun shared design tokens — dark ink/paper/blood/gold. Linked by every page. */
:root {
  --ink: #0E0E10;
  --paper: #F2EFE9;
  --blood: #B33A3A;
  --gold: #D4AF37;
  --muted: #5A5A5A;
  --card: #161618;
  --tab-bar-h: 62px;
}
```

- [ ] **Step 2: `app-shell.css`**
```css
/* Bottom tab bar — fixed, app-like. Injected on every page by app-shell.js. */
#app-tabbar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 90;
  display: flex; height: var(--tab-bar-h);
  background: rgba(14,14,16,.92); backdrop-filter: blur(12px);
  border-top: 1px solid rgba(242,239,233,.10);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
#app-tabbar a {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: .12rem; text-decoration: none; color: rgba(242,239,233,.55);
  font: 500 .62rem/1 'Inter', sans-serif; letter-spacing: .04em; text-transform: uppercase;
  transition: color .15s ease; position: relative;
}
#app-tabbar a .ti { font-size: 1.25rem; line-height: 1; filter: grayscale(1) opacity(.75); transition: filter .15s ease; }
#app-tabbar a[aria-current="page"] { color: var(--gold); }
#app-tabbar a[aria-current="page"] .ti { filter: none; }
#app-tabbar a .badge {
  position: absolute; top: 8px; right: calc(50% - 22px);
  min-width: 8px; height: 8px; border-radius: 999px; background: var(--blood);
  box-shadow: 0 0 0 2px var(--ink);
}
#app-tabbar a .badge[hidden] { display: none; }
body.has-tabbar { padding-bottom: var(--tab-bar-h) !important; }
```

- [ ] **Step 3: `app-shell.js`**
```js
// Saturfun app shell: injects the bottom tab bar, marks the active tab,
// registers the unified root service worker, and migrates off the old wall SW.
(function () {
  var TABS = [
    { id: "trip",   label: "Trip",   icon: "🗺️", href: "index.html",  match: ["index.html", ""] },
    { id: "wall",   label: "Wall",   icon: "🖼️", href: "wall.html",   match: ["wall.html"] },
    { id: "panels", label: "Panels", icon: "🎴", href: "manga.html",  match: ["manga.html", "panels.html"] },
    { id: "plan",   label: "Plan",   icon: "✨", href: "plan.html",   match: ["plan.html"] },
  ];
  function currentFile() {
    var p = location.pathname.split("/").pop() || "";
    return p;
  }
  function build() {
    if (document.getElementById("app-tabbar")) return;
    var cur = currentFile();
    var nav = document.createElement("nav");
    nav.id = "app-tabbar";
    nav.setAttribute("aria-label", "Saturfun sections");
    nav.innerHTML = TABS.map(function (t) {
      var active = t.match.indexOf(cur) !== -1;
      return '<a href="' + t.href + '"' + (active ? ' aria-current="page"' : "") + '>' +
        '<span class="ti" aria-hidden="true">' + t.icon + '</span>' +
        '<span class="tl">' + t.label + '</span>' +
        (t.id === "plan" ? '<span class="badge" id="tab-plan-badge" hidden></span>' : "") +
        '</a>';
    }).join("");
    document.body.appendChild(nav);
    document.body.classList.add("has-tabbar");
  }
  window.saturfunSetPlanBadge = function (on) { var b = document.getElementById("tab-plan-badge"); if (b) b.hidden = !on; };
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    // Migrate: unregister the old wall-scoped SW so the unified root SW takes over.
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      regs.forEach(function (r) {
        var u = (r.active && r.active.scriptURL) || "";
        if (u.indexOf("wall-sw.js") !== -1) r.unregister();
      });
    }).catch(function () {});
    navigator.serviceWorker.register("sw.js").catch(function (e) { console.warn("[shell] SW register failed:", e); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
  registerSW();
})();
```
NOTE TO IMPLEMENTER: use the snippet verbatim; `node --check app-shell.js` must pass. The `window.saturfunSetPlanBadge` global is used by SP3/SP4 to badge the Plan tab.

- [ ] **Step 4: Verify** — `node --check app-shell.js`; confirm `tokens.css`/`app-shell.css` are valid CSS (no unclosed braces); grep that `app-shell.js` has `serviceWorker.register("sw.js")`, the wall-sw unregister, `aria-current`, and `saturfunSetPlanBadge`.

- [ ] **Step 5: Commit**
```bash
git add tokens.css app-shell.css app-shell.js
git commit -m "feat(shell): shared dark tokens + bottom tab bar + unified SW registration"
```

---

### Task 2: Unified service worker + manifest + Plan placeholder

**Files:** Create `sw.js`, `saturfun.webmanifest`, `plan.html`.

**Interfaces:** Consumes the shell files from Task 1 (precaches them). Produces a root-scoped SW controlling `/Saturfun-Itinerary/` and a unified manifest.

- [ ] **Step 1: `sw.js`** (mirror the proven `wall-sw.js` structure; widen the shell)
```js
// Saturfun unified service worker (root scope /Saturfun-Itinerary/).
// Network-first for the app shell (fresh after deploy) + cache fallback (offline).
// Handles ONLY same-origin shell paths; passes through everything else — including
// all cross-origin calls to saturfun-worker (never caches /api/*).
const CACHE = "saturfun-app-v1";
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
```

- [ ] **Step 2: `saturfun.webmanifest`**
```json
{
  "id": "/Saturfun-Itinerary/",
  "name": "Saturfun",
  "short_name": "Saturfun",
  "description": "Brooklyn itinerary, shared photo wall, and manga panel vault — one app.",
  "start_url": "./index.html",
  "scope": "./",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#0E0E10",
  "theme_color": "#0E0E10",
  "icons": [
    { "src": "wall-icon-192.png", "sizes": "192x192", "purpose": "any" },
    { "src": "wall-icon-512.png", "sizes": "512x512", "purpose": "any" },
    { "src": "wall-icon-maskable.png", "sizes": "512x512", "purpose": "maskable" }
  ]
}
```

- [ ] **Step 3: `plan.html`** — a minimal dark page (links tokens.css + app-shell.css, includes app-shell.js) with a hero placeholder: "✨ Plan — your itinerary planner is coming. It'll suggest new stops and let you shape them." Mirror the wall.html head pattern (manifest, theme-color, apple metas, tokens.css, app-shell.css) + `<script src="app-shell.js" defer></script>` before `</body>`. Give `<body class="...">` room (app-shell adds `has-tabbar`).

- [ ] **Step 4: Verify** — `node --check sw.js`; JSON-validate the manifest (`node -e "JSON.parse(require('fs').readFileSync('saturfun.webmanifest'))"`); confirm `plan.html` links tokens.css + app-shell.js. Confirm the SW `SHELL` includes all 5 html + shared assets + icons and that the fetch handler keeps the same-origin+shell guard.

- [ ] **Step 5: Commit**
```bash
git add sw.js saturfun.webmanifest plan.html
git commit -m "feat(shell): unified root service worker + manifest + Plan placeholder"
```

---

### Task 3: Wire the shell into all 4 existing pages + retire wall PWA wiring

**Files:** Modify `index.html`, `wall.html`, `manga.html`, `panels.html`, `wall.js`.

**Interfaces:** Each page gains the shared head (manifest, theme-color, apple metas, apple-touch-icon, `tokens.css`, `app-shell.css`) + `<script src="app-shell.js" defer></script>` before `</body>`. `wall.js` stops registering `wall-sw.js`.

- [ ] **Step 1: Add the shared head block to each page** — insert into each `<head>` (for `index.html` after its `<style>` closes; for the others after their font `<link>`). The block:
```html
<link rel="manifest" href="saturfun.webmanifest">
<meta name="theme-color" content="#0E0E10">
<link rel="icon" href="wall-icon-192.png">
<link rel="apple-touch-icon" href="wall-apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="apple-mobile-web-app-title" content="Saturfun">
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="app-shell.css">
```
For `wall.html`: REPLACE its existing `wall.webmanifest` link + its own theme-color/apple metas/apple-touch-icon (lines ~8–15) with the block above (so it uses the unified manifest); keep `wall.css`. Ensure `apple-mobile-web-app-title` becomes "Saturfun".

- [ ] **Step 2: Add `app-shell.js` before `</body>`** on all 4 pages:
```html
<script src="app-shell.js" defer></script>
```
(Place after existing scripts. For `index.html`, ensure it doesn't interfere with the GSAP `#smooth-content` — the tab bar is appended to `<body>`, outside `#smooth-wrapper`, which is correct; verify the fixed bar isn't inside the transformed ScrollSmoother container. If ScrollSmoother wraps everything, the fixed `#app-tabbar` must still be a direct child of `<body>` appended after — confirm live.)

- [ ] **Step 3: Retire the wall SW registration** — in `wall.js`, remove the line `navigator.serviceWorker.register("wall-sw.js", { scope: "wall" })...` (app-shell.js now registers the unified root SW). Leave the rest of wall.js untouched.

- [ ] **Step 4: Bottom-bar clearance** — the `body.has-tabbar { padding-bottom: var(--tab-bar-h) }` rule (Task 1) covers most pages. For `index.html`'s GSAP ScrollSmoother, padding on `<body>` may not apply to the scrolled content — if the footer is hidden behind the bar, add `padding-bottom: var(--tab-bar-h)` to `#smooth-content` (or the footer's container) in index.html's CSS. Confirm live in Task 5; add the targeted rule if needed.

- [ ] **Step 5: Verify** — `node --check wall.js`; grep each page for `saturfun.webmanifest`, `tokens.css`, `app-shell.js`; grep wall.html to confirm `wall.webmanifest` is GONE; grep wall.js to confirm the `wall-sw.js` register is GONE.

- [ ] **Step 6: Commit**
```bash
git add index.html wall.html manga.html panels.html wall.js
git commit -m "feat(shell): wire tab bar + unified manifest/SW into all pages; retire wall PWA wiring"
```

---

### Task 4: Dark re-theme of index.html

**Files:** Modify `index.html` (CSS only — do not touch structure/JS).

**Interfaces:** The itinerary page renders in the dark ink/paper/blood/gold system, visually cohesive with the other tabs, layout + interactions unchanged.

- [ ] **Step 1: Invert the `:root` tokens** (index.html ~lines 17–22) to the dark system, keeping the same variable NAMES so downstream `var(--...)` references flip automatically:
```css
--bg-color: #0E0E10;      /* was #FAFAFA */
--text-main: #F2EFE9;     /* was #1C1C1C */
--text-muted: #9A968E;    /* was #6B6B6B — lightened for dark bg */
--accent: #D4AF37;        /* gold unchanged */
```
Add (if not present) `--blood: #B33A3A;` `--card: #161618;` for surfaces.

- [ ] **Step 2: Convert the ~63 hardcoded light literals.** Systematically, within index.html's CSS only:
  - Light surfaces `#fff` / `#FFFFFF` / `#FFFDF6` used as backgrounds → `var(--card)` (cards) or `var(--ink)` (page-level). `#fff` used as TEXT on a colored button → keep `#fff` (white text on blood/gold reads fine) — judge per use.
  - Dark literals `#1C1C1C` / `#000` used as text → `var(--text-main)`; used as button bg (e.g. `#saturfun-map-toggle:hover{background:#000}`) → `var(--card)` or a gold/blood hover.
  - Shadows `rgba(0,0,0,.x)` (dark-on-light) → reduce/soften for dark mode (e.g. `rgba(0,0,0,.5)` deeper, or switch subtle borders to `rgba(242,239,233,.08)`). Pin/halo `border:3px solid #fff` → keep white (reads on map) or `var(--paper)`.
  - `rgba(28,28,28,...)` (was dark accents on light) → `rgba(242,239,233,...)` equivalents.
  - `rgba(212,175,55,...)` gold accents → keep.
  Work through each literal (the scout found them near lines 158, 176, 205, 368, 447, 501, 584, 620, 708, 751, 766, 822, 878, 1454, and more — grep `#fff|#FFF|#1C1C1C|#000|rgba\(0,0,0|rgba\(28,28,28`). Do NOT change map tile imagery or photo/venue images.

- [ ] **Step 2b: Self-check** — grep index.html CSS again for remaining `#fff|#FFFFFF|#FFFDF6|#1C1C1C(?!.*var)|background:\s*#000`. Each remaining one must be a deliberate keep (e.g. white text on blood). List them in the report with the reason.

- [ ] **Step 3: Verify** — `node --check` is N/A (HTML); instead open `index.html` locally is not possible headless, so this task's real verification is the LIVE check in Task 5 (screenshots). For now confirm the file still parses (no broken `<style>`; the page's inline `<script>` is untouched) via a grep that `:root` has the new dark values and there's no dangling brace.

- [ ] **Step 4: Commit**
```bash
git add index.html
git commit -m "feat(shell): re-theme itinerary to the dark ink/paper/blood/gold system"
```

---

### Task 5: Deploy + live verification (controller-run)

- [ ] **Step 1: Bump SW cache** — `sw.js`: `const CACHE = "saturfun-app-v2";` (v1→v2 so installed clients update). Commit `chore(pwa): bump app SW cache for shell rollout`.
- [ ] **Step 2: Push** — `git push origin main` + `git push origin main:gh-pages --force`.
- [ ] **Step 3: Wait for Pages publish** (poll for `app-shell.js` live).
- [ ] **Step 4: Live verify (chrome-devtools) — on the website:**
  - All 4 tabs load: `index.html`, `wall.html`, `manga.html`, `plan.html`; the bottom tab bar renders on each with the correct active tab highlighted; tapping tabs navigates.
  - `index.html` is dark + cohesive (screenshot; check hero, track picker, itinerary cards, map, footer — no leftover white boxes; text readable; the tab bar doesn't cover the footer).
  - The unified SW controls every page (`navigator.serviceWorker.controller` non-null on index + manga, not just wall); the old wall SW is gone.
  - Wall features still work (open a photo, reactions/comments present, whirlwind gate intact) — cross-origin `/api/*` still works (SW passes through).
  - Install: the manifest is valid (one "Saturfun" install), start_url = Trip.
  - No console errors on any page.
- [ ] **Step 5:** Fix anything broken (esp. index re-theme leftovers / tab overlap), re-deploy (bump cache), re-verify until clean.

## Self-Review
- **Coverage:** shared tokens + tab bar + SW-registration (T1); unified SW + manifest + Plan placeholder (T2); wire into all pages + retire wall PWA (T3); dark re-theme itinerary (T4); deploy + live verify both surfaces (T5). SW passes through cross-origin API (constraint). Old wall SW migrated. Bottom-bar clearance handled.
- **Placeholders:** none — all shared files have complete, `node --check`-clean code. Task 4's literal conversion is judgment-based by design (light→dark mapping), bounded by the grep self-check in Step 2b + live screenshots in T5.
- **Type/name consistency:** `#app-tabbar` / `has-tabbar` / `--tab-bar-h` / `saturfunSetPlanBadge` used consistently across app-shell.css/js and reserved for SP3/SP4; `sw.js` `CACHE` bumped in T5; manifest icons reuse existing files.
