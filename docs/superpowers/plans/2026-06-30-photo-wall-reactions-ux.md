# Photo Wall — Reactions UX (emojis under tiles + long-press to react) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Show each photo's emoji reactions in a row UNDER the tile (display-only, not overlaid inside), and let people react from the grid via a **long-press** menu (quick emojis + any-emoji).

**Architecture:** Frontend-only — the `POST /api/photos/{id}/react` API and `reactions:[{emoji,count,mine}]` list field already exist. Restructure each grid cell into a `.tile-card` (the image button + a `.tile-reactions` row beneath). Generalize the reaction toggle to work on any photo id (`reactOn(photoId, emoji)`, still serialized through `rxChain`). Add a long-press / right-click react menu (`#reactMenu`) that reacts on the pressed photo without opening the lightbox. The lightbox chips + picker are unchanged.

**Tech Stack:** vanilla JS (no build), no frontend test framework — verify via `node --check` + live browser.

## Global Constraints
- Frontend-only: touch `wall.js`, `wall.css`, `wall.html` ONLY. No backend / migration / worker change.
- Keep the existing reaction data flow: `reactions:[{emoji,count,mine}]`, `postReaction`, `applyReactions`, the `rxChain` serialization, the `loadPhotos` change-signature + lightbox reconcile, and `deviceId()`.
- Tile reactions under photos are **display-only** (not tappable). Reacting happens via long-press (grid) or the lightbox picker.
- Long-press must NOT also open the lightbox; a normal tap still opens it.
- Bump `CACHE` in `wall-sw.js` (v8 → v9) on deploy. No AI / no new deps.

## File Structure
- Modify `wall.js` — `reactOn()` refactor; tile card restructure + `renderTileReactions()`; `applyReactions` targets the under-tile row; long-press/contextmenu handlers + `#reactMenu` logic; wiring in `init()`.
- Modify `wall.css` — `.tile-card` / `.tile-reactions` layout (replaces the `.tile-react` overlay); `#reactMenu` popup + backdrop.
- Modify `wall.html` — add the `#reactMenu` popup markup.
- Modify `wall-sw.js` — bump `CACHE`.

---

### Task 1: Emojis under the tile (display-only) + `reactOn` refactor

**Files:** Modify `wall.js`, `wall.css`.

**Interfaces:**
- Produces: `reactOn(photoId, emoji)` (serialized react on any photo); `renderTileReactions(photoId, reactions)` (fills the under-tile row). `toggleReaction(emoji)` now delegates to `reactOn(current.id, emoji)`. Tiles are wrapped in `.tile-card[data-id]`.

- [ ] **Step 1: Generalize the toggle to any photo** — in `wall.js`, replace the current `rxChain`/`toggleReaction`:
```js
let rxChain = Promise.resolve();
function reactOn(photoId, emoji) {
  rxChain = rxChain.then(async () => {
    try { applyReactions(photoId, await postReaction(photoId, emoji)); }
    catch (e) { toast("Couldn't react."); }
  });
}
function toggleReaction(emoji) { if (current) reactOn(current.id, emoji); }
```

- [ ] **Step 2: Replace the overlay helper with an under-tile renderer** — delete `tileReactionHTML(...)`; add:
```js
// Display-only reaction row under a tile: "❤️ 2" chips (not interactive).
function tileReactionsHTML(reactions) {
  if (!reactions || !reactions.length) return "";
  return reactions.map((r) => `<span class="tr-chip${r.mine ? " mine" : ""}">${esc(r.emoji)} ${r.count}</span>`).join("");
}
function renderTileReactions(photoId, reactions) {
  const card = document.querySelector(`#photoGrid .tile-card[data-id="${photoId}"]`);
  if (!card) return;
  let row = card.querySelector(".tile-reactions");
  const html = tileReactionsHTML(reactions);
  if (!html) { if (row) row.remove(); return; }
  if (!row) { row = document.createElement("div"); row.className = "tile-reactions"; card.appendChild(row); }
  row.innerHTML = html;
}
```

- [ ] **Step 3: Build tiles as cards with the row beneath** — in `loadPhotos()`, change the tile-building loop so each grid child is a `.tile-card` wrapping the image button + the under-row. Replace the block that creates `tile` and sets its `innerHTML`/click with:
```js
        const card = document.createElement("div");
        card.className = "tile-card";
        card.dataset.id = p.id;
        const tile = document.createElement("button");
        tile.className = "tile" + (selected.has(p.id) ? " selected" : "");
        tile.type = "button";
        tile.dataset.id = p.id;
        tile.innerHTML =
          `<img src="${PHOTO_API}/api/photos/${esc(p.id)}/thumb" loading="lazy" alt="${esc(p.filename)}">` +
          `<span class="check" aria-hidden="true">✓</span>`;
        tile.addEventListener("click", () => {
          if (selectMode) toggleTile(p, tile);
          else openLightbox(p);
        });
        card.appendChild(tile);
        const rxHTML = tileReactionsHTML(p.reactions);
        if (rxHTML) { const row = document.createElement("div"); row.className = "tile-reactions"; row.innerHTML = rxHTML; card.appendChild(row); }
        grid.appendChild(card);
```
(Keep `toggleTile`/selection keyed on the `.tile` button; note the selection code that queries `.tile[data-id=...]` still works because the button also carries `data-id`.)

- [ ] **Step 4: Point `applyReactions` at the under-tile row** — in `applyReactions`, replace the block that updated the old `.tile-react` overlay with:
```js
  renderTileReactions(photoId, reactions);
```
(Keep the `current`/`PHOTOS`/`lastSig` updates exactly as they are.)

- [ ] **Step 5: CSS** — in `wall.css`, REMOVE the `.tile-react { ... }` rule and add:
```css
.tile-card { display: flex; flex-direction: column; gap: .3rem; }
.tile-card .tile { width: 100%; }
.tile-reactions { display: flex; flex-wrap: wrap; gap: .25rem; padding: 0 .1rem; }
.tr-chip { display: inline-flex; align-items: center; gap: .15rem; font-size: .72rem; line-height: 1.4;
  padding: .05rem .32rem; border-radius: 999px; background: rgba(255,255,255,.05);
  border: 1px solid rgba(242,239,233,.1); color: rgba(242,239,233,.85); }
.tr-chip.mine { background: rgba(179,58,58,.2); border-color: rgba(179,58,58,.5); color: var(--paper); }
```
Also ensure `#photoGrid` still lays out cards (it targets direct children — now `.tile-card` instead of `.tile`; the existing `grid-template-columns` needs no change). If any `#photoGrid > .tile` selector exists, retarget to `.tile-card`.

- [ ] **Step 6: Verify + commit** — `node --check wall.js`; grep that `tile-card`, `tile-reactions`, `reactOn`, `renderTileReactions` exist and `tile-react`/`tileReactionHTML` are gone. Manually re-read `loadPhotos`, `applyReactions`, `openLightbox` for consistency.
```bash
git add wall.js wall.css
git commit -m "feat(reactions-ux): emojis under tiles (display-only) + reactOn(photoId)"
```

---

### Task 2: Long-press (and right-click) to react from the grid

**Files:** Modify `wall.js`, `wall.css`, `wall.html`.

**Interfaces:**
- Consumes: `reactOn(photoId, emoji)`, `QUICK_EMOJI`, `esc`, `isValidEmoji`-equivalent client cap (`Array.from(v).slice(0,8)`).
- Produces: `#reactMenu` popup + `openReactMenu(photoId)`; long-press/contextmenu handlers on tiles.

- [ ] **Step 1: Menu markup** — in `wall.html`, before `<div id="toast" ...>`, add:
```html
<div id="reactMenu" hidden>
  <div id="reactMenuBackdrop"></div>
  <div id="reactMenuBar" role="menu" aria-label="React">
    <div id="reactMenuQuick"></div>
    <input id="reactMenuInput" class="rx-input" inputmode="text" enterkeyhint="done" placeholder="type any emoji…" aria-label="Type any emoji" hidden>
  </div>
</div>
```

- [ ] **Step 2: Menu logic** — in `wall.js`, add:
```js
let reactMenuPhoto = null;
function openReactMenu(photoId) {
  reactMenuPhoto = photoId;
  const quick = $("reactMenuQuick");
  quick.innerHTML = QUICK_EMOJI.map((em) => `<button type="button" class="rm-q" data-emoji="${esc(em)}">${esc(em)}</button>`).join("")
    + `<button type="button" class="rm-q rm-more" id="reactMenuMore" aria-label="Any emoji">➕</button>`;
  $("reactMenuInput").hidden = true;
  $("reactMenuInput").value = "";
  $("reactMenu").hidden = false;
}
function closeReactMenu() { $("reactMenu").hidden = true; reactMenuPhoto = null; }
function setupReactMenu() {
  $("reactMenuBackdrop").addEventListener("click", closeReactMenu);
  $("reactMenuQuick").addEventListener("click", (e) => {
    const b = e.target.closest(".rm-q");
    if (!b) return;
    if (b.id === "reactMenuMore") { $("reactMenuInput").hidden = false; $("reactMenuInput").focus(); return; }
    const pid = reactMenuPhoto;
    closeReactMenu();
    if (pid && b.dataset.emoji) reactOn(pid, b.dataset.emoji);
  });
  $("reactMenuInput").addEventListener("input", (e) => {
    const v = e.target.value.trim(); e.target.value = "";
    const pid = reactMenuPhoto;
    closeReactMenu();
    if (pid && v) reactOn(pid, Array.from(v).slice(0, 8).join(""));
  });
}
```

- [ ] **Step 3: Long-press + right-click detection** — in `loadPhotos`'s tile builder (Task 1 Step 3), after the `tile.addEventListener("click", ...)`, add long-press wiring to the `tile`:
```js
        let lpTimer = null, lpFired = false;
        const startLP = () => { lpFired = false; lpTimer = setTimeout(() => { lpFired = true; openReactMenu(p.id); }, 450); };
        const cancelLP = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
        tile.addEventListener("touchstart", startLP, { passive: true });
        tile.addEventListener("touchend", cancelLP);
        tile.addEventListener("touchmove", cancelLP, { passive: true });
        tile.addEventListener("touchcancel", cancelLP);
        tile.addEventListener("contextmenu", (e) => { e.preventDefault(); openReactMenu(p.id); }); // desktop right-click
```
And guard the existing click handler so a long-press doesn't also open the lightbox — change the click listener added in Task 1 Step 3 to:
```js
        tile.addEventListener("click", (e) => {
          if (lpFired) { lpFired = false; e.preventDefault(); return; }
          if (selectMode) toggleTile(p, tile);
          else openLightbox(p);
        });
```
(`lpTimer`/`lpFired` are per-tile closures — declare them just before this block.)

- [ ] **Step 4: Wire + suppress the iOS callout** — in `init()`, add `setupReactMenu();`.

- [ ] **Step 5: CSS** — in `wall.css`, add:
```css
.tile { -webkit-touch-callout: none; user-select: none; }
#reactMenu { position: fixed; inset: 0; z-index: 55; display: flex; align-items: center; justify-content: center; }
#reactMenuBackdrop { position: absolute; inset: 0; background: rgba(8,8,9,.55); }
#reactMenuBar { position: relative; z-index: 1; display: flex; flex-direction: column; gap: .5rem; align-items: center;
  padding: .7rem .8rem; border-radius: 16px; background: #161618; border: 1px solid rgba(242,239,233,.14);
  box-shadow: 0 16px 44px rgba(0,0,0,.6); max-width: 92vw; }
#reactMenuQuick { display: flex; gap: .35rem; flex-wrap: wrap; justify-content: center; }
.rm-q { font-size: 1.6rem; line-height: 1; padding: .3rem .4rem; border-radius: 12px; border: 1px solid transparent;
  background: rgba(255,255,255,.04); cursor: pointer; }
.rm-q:hover { border-color: rgba(212,175,55,.5); }
.rm-more { font-size: 1.2rem; }
```

- [ ] **Step 6: Verify + commit** — `node --check wall.js`; grep that `reactMenu`, `openReactMenu`, `setupReactMenu`, `contextmenu`, `touchstart` are present. Re-read the click/long-press guard for correctness (a normal tap opens the lightbox; a ≥450ms hold opens the menu and suppresses the tap).
```bash
git add wall.js wall.css wall.html
git commit -m "feat(reactions-ux): long-press / right-click to react from the grid"
```

---

### Task 3: Deploy + live verify (controller-run)
- [ ] Bump `wall-sw.js` `CACHE` → `saturfun-wall-v9`; commit `chore(pwa): bump SW cache v9 for reactions-ux`.
- [ ] Push main + gh-pages.
- [ ] Live browser verify: reactions render UNDER tiles (not overlaid); a normal tap opens the lightbox; a long-press opens the react menu; tapping a quick emoji reacts (chip appears under the tile, `mine` highlighted); ➕ → typed emoji reacts; right-click (desktop) opens the menu; the under-tile row and lightbox stay consistent; clean up test reactions.

## Self-Review
- **Coverage:** emojis under tiles display-only (T1); long-press + right-click react menu with quick + any emoji (T2); deploy + verify (T3). No backend change (API already supports it).
- **Placeholders:** none.
- **Type consistency:** `reactOn(photoId, emoji)` used by `toggleReaction`, the tile long-press, and the menu; `renderTileReactions(photoId, reactions)` + `applyReactions` both target `.tile-card[data-id]`; `tileReactionsHTML` used in both the initial render (loadPhotos) and `renderTileReactions`.
