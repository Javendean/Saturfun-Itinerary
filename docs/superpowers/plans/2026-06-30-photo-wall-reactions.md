# Photo Wall — Emoji Reactions (supersedes binary likes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single ❤ like with multi-emoji reactions (react with ❤️/😂/‼️/any emoji; each emoji an independent per-device toggle), shown as chips with counts in the lightbox and a compact summary on tiles.

**Architecture:** A new D1 `reactions(photo_id, device_id, emoji)` table (composite PK = one of each emoji per device per photo; a device may use many emojis) replaces the binary `likes`. Existing likes migrate to ❤️ reactions. `reaction-store.ts` wraps the ops + validates emoji input. `GET /api/photos?device=` returns each photo's `reactions: [{emoji,count,mine}]`; `POST /api/photos/{id}/react {device_id,emoji}` toggles one emoji and returns the photo's summary. Frontend: lightbox reaction chips + a quick-react row + an emoji-keyboard input; tile summary; rides the existing auto-refresh. The old `like-store.ts`, `/like` route, and ❤ button are removed.

**Tech Stack:** Cloudflare Worker (TypeScript) · D1 · `@cloudflare/vitest-pool-workers` (Vitest 4) · vanilla JS frontend (no build) · Python httpx UAT.

## Global Constraints
- No login / accounts — identity is the anonymous `localStorage` device UUID (`saturfun_device_id`, already shipped).
- D1: **all values are bound parameters** — never string-concatenate SQL.
- **Emoji input is user-controlled and public** — validate server-side (`isValidEmoji`: 1–8 code points, contains an emoji pictographic, no ASCII letters) AND escape on render. Reject invalid with 400.
- Do not change the existing owner-token DELETE, CORS model, or upload routes.
- Migration `0003` must be NEW (never edit the already-applied `0001`/`0002`). Leave the `likes` table in place (dormant) after copying its rows — do NOT drop it (avoids a serving gap during deploy).
- Tests run via `npm run test:run` in `worker/`. After any frontend deploy, bump `CACHE` in `wall-sw.js` (PWA update rule). No AI / no Anthropic API.
- D1 migrations are applied manually: `npx wrangler d1 migrations apply saturfun-db --remote`.

## File Structure
- Create `worker/migrations/0003_reactions.sql` — `reactions` table + index + copy `likes`→`❤️`.
- Create `worker/src/reaction-store.ts` — reaction ops + `isValidEmoji` + augmented list.
- Create `worker/test/reactions.spec.ts` — store + route tests.
- Modify `worker/src/photo-routes.ts` — GET returns `reactions`; `POST .../react` (validated); cascade; **remove** the `like-store` import, the `/like` route, and the `like_count`/`liked` fields.
- Delete `worker/src/like-store.ts` and `worker/test/likes.spec.ts` (superseded).
- Modify `wall.js`, `wall.css`, `wall.html` — replace the ❤ button with reaction chips + quick-react row + emoji input; tile summary.
- Modify `worker/scripts/photo_wall_uat.py` — replace the like round-trip with a react round-trip.
- Modify `wall-sw.js` — bump `CACHE` (v6 → v7).

---

### Task 1: D1 `reactions` table + migrate likes (migration)

**Files:**
- Create: `worker/migrations/0003_reactions.sql`

**Interfaces:**
- Produces: `reactions(photo_id, device_id, emoji, created, PK(photo_id,device_id,emoji))` + `idx_reactions_photo`; existing `likes` rows copied as `❤️` reactions. The vitest harness auto-applies all `migrations/*.sql`.

- [ ] **Step 1: Write the migration**

`worker/migrations/0003_reactions.sql`:
```sql
-- Emoji reactions: one row = one (photo, device, emoji). A device may add many emojis.
CREATE TABLE IF NOT EXISTS reactions (
    photo_id  TEXT NOT NULL,
    device_id TEXT NOT NULL,
    emoji     TEXT NOT NULL,
    created   REAL NOT NULL,
    PRIMARY KEY (photo_id, device_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_photo ON reactions(photo_id);

-- Carry forward existing binary likes as ❤️ reactions (likes table left dormant).
INSERT OR IGNORE INTO reactions (photo_id, device_id, emoji, created)
    SELECT photo_id, device_id, '❤️', created FROM likes;
```

- [ ] **Step 2: Apply to the LOCAL dev DB**

Run (in `worker/`): `npx wrangler d1 migrations apply saturfun-db-test --local --config wrangler.test.toml`
Expected: `0003_reactions.sql ✅`.

- [ ] **Step 3: Commit**

```bash
git add worker/migrations/0003_reactions.sql
git commit -m "feat(reactions): add D1 reactions table + migrate likes->❤️ (migration 0003)"
```

---

### Task 2: `reaction-store.ts` — ops + emoji validation + augmented list

**Files:**
- Create: `worker/src/reaction-store.ts`
- Test: `worker/test/reactions.spec.ts`

**Interfaces:**
- Consumes: `Env` (needs `DB`); `PhotoMeta` from `./photo-store`; `saveUpload`/`addPhoto` in tests.
- Produces:
  - `interface Reaction { emoji: string; count: number; mine: boolean }`
  - `isValidEmoji(s: unknown): boolean`
  - `reactionsFor(env, photoId, deviceId: string|null): Promise<Reaction[]>`
  - `toggleReaction(env, photoId, deviceId: string, emoji: string): Promise<Reaction[]>`
  - `deleteReactionsFor(env, photoId): Promise<void>`
  - `listPhotosWithReactions(env, deviceId: string|null): Promise<(PhotoMeta & { reactions: Reaction[] })[]>`

- [ ] **Step 1: Write the failing tests**

`worker/test/reactions.spec.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { saveUpload, addPhoto } from "../src/photo-store";
import { isValidEmoji, reactionsFor, toggleReaction, deleteReactionsFor, listPhotosWithReactions } from "../src/reaction-store";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
async function seedPhoto(name = "p.png") { const m = await saveUpload(env, PNG, name); await addPhoto(env, m); return m; }

describe("isValidEmoji", () => {
  it("accepts real emoji incl. ZWJ + variation selectors", () => {
    for (const e of ["❤️", "😂", "‼️", "👍", "👨‍👩‍👧‍👦", "🔥"]) expect(isValidEmoji(e)).toBe(true);
  });
  it("rejects text, empty, whitespace, overlong, and non-strings", () => {
    for (const bad of ["", " ", "haha", "lol😂", "a", "<script>", "x".repeat(20), "😂😂😂😂😂😂😂😂😂", 5, null, undefined])
      expect(isValidEmoji(bad as any)).toBe(false);
  });
});

describe("reaction store", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM reactions").run();
    await env.DB.prepare("DELETE FROM photos").run();
  });

  it("toggles one emoji on/off and reports count + mine", async () => {
    const p = await seedPhoto();
    let rx = await toggleReaction(env, p.id, "dev-1", "😂");
    expect(rx).toEqual([{ emoji: "😂", count: 1, mine: true }]);
    rx = await toggleReaction(env, p.id, "dev-1", "😂");
    expect(rx).toEqual([]); // removed
  });

  it("lets one device stack multiple distinct emojis", async () => {
    const p = await seedPhoto();
    await toggleReaction(env, p.id, "dev-1", "❤️");
    const rx = await toggleReaction(env, p.id, "dev-1", "😂");
    const map = Object.fromEntries(rx.map((r) => [r.emoji, r]));
    expect(map["❤️"]).toEqual({ emoji: "❤️", count: 1, mine: true });
    expect(map["😂"]).toEqual({ emoji: "😂", count: 1, mine: true });
  });

  it("aggregates counts across devices; mine is per-device", async () => {
    const p = await seedPhoto();
    await toggleReaction(env, p.id, "dev-1", "❤️");
    await toggleReaction(env, p.id, "dev-2", "❤️");
    await toggleReaction(env, p.id, "dev-2", "🔥");
    const forDev1 = await reactionsFor(env, p.id, "dev-1");
    const heart = forDev1.find((r) => r.emoji === "❤️")!;
    const fire = forDev1.find((r) => r.emoji === "🔥")!;
    expect(heart).toEqual({ emoji: "❤️", count: 2, mine: true });
    expect(fire).toEqual({ emoji: "🔥", count: 1, mine: false });
  });

  it("listPhotosWithReactions attaches per-photo reactions; null device → mine all false", async () => {
    const p1 = await seedPhoto("a.png");
    const p2 = await seedPhoto("b.png");
    await toggleReaction(env, p1.id, "dev-1", "❤️");
    const anon = await listPhotosWithReactions(env, null);
    const byId = Object.fromEntries(anon.map((p) => [p.id, p]));
    expect(byId[p1.id].reactions).toEqual([{ emoji: "❤️", count: 1, mine: false }]);
    expect(byId[p2.id].reactions).toEqual([]);
  });

  it("deleteReactionsFor clears a photo's reactions", async () => {
    const p = await seedPhoto();
    await toggleReaction(env, p.id, "dev-1", "❤️");
    await deleteReactionsFor(env, p.id);
    expect(await reactionsFor(env, p.id, "dev-1")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (in `worker/`): `npm run test:run`
Expected: FAIL — `Cannot find module '../src/reaction-store'`.

- [ ] **Step 3: Write `reaction-store.ts`**

`worker/src/reaction-store.ts`:
```ts
// Emoji reactions: one row per (photo, device, emoji). A device may stack many emojis.
import type { Env } from "./types";
import type { PhotoMeta } from "./photo-store";

type RxEnv = Pick<Env, "DB">;
export interface Reaction { emoji: string; count: number; mine: boolean; }

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
// Accept a short emoji string (1–8 code points, contains a pictographic, no ASCII letters).
// Rejects plain text, injected markup, and overlong blobs. Output is still escaped on render.
export function isValidEmoji(s: unknown): boolean {
  if (typeof s !== "string") return false;
  const cps = Array.from(s);
  if (cps.length < 1 || cps.length > 8) return false;
  if (/[A-Za-z]/.test(s)) return false;
  if (/\s/.test(s)) return false;
  return PICTOGRAPHIC.test(s);
}

export async function reactionsFor(env: RxEnv, photoId: string, deviceId: string | null): Promise<Reaction[]> {
  const { results } = await env.DB.prepare(
    `SELECT emoji, COUNT(*) AS count, MAX(CASE WHEN device_id = ?2 THEN 1 ELSE 0 END) AS mine
       FROM reactions WHERE photo_id = ?1
       GROUP BY emoji ORDER BY count DESC, emoji ASC`,
  ).bind(photoId, deviceId ?? "").all<{ emoji: string; count: number; mine: number }>();
  return results.map((r) => ({ emoji: r.emoji, count: r.count, mine: r.mine > 0 }));
}

export async function toggleReaction(env: RxEnv, photoId: string, deviceId: string, emoji: string): Promise<Reaction[]> {
  const existing = await env.DB.prepare(
    "SELECT 1 AS x FROM reactions WHERE photo_id = ? AND device_id = ? AND emoji = ?",
  ).bind(photoId, deviceId, emoji).first<{ x: number }>();
  if (existing) {
    await env.DB.prepare("DELETE FROM reactions WHERE photo_id = ? AND device_id = ? AND emoji = ?")
      .bind(photoId, deviceId, emoji).run();
  } else {
    await env.DB.prepare("INSERT OR IGNORE INTO reactions (photo_id, device_id, emoji, created) VALUES (?, ?, ?, ?)")
      .bind(photoId, deviceId, emoji, Date.now() / 1000).run();
  }
  return reactionsFor(env, photoId, deviceId);
}

export async function deleteReactionsFor(env: RxEnv, photoId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM reactions WHERE photo_id = ?").bind(photoId).run();
}

export async function listPhotosWithReactions(
  env: RxEnv,
  deviceId: string | null,
): Promise<(PhotoMeta & { reactions: Reaction[] })[]> {
  const { results: photos } = await env.DB.prepare("SELECT * FROM photos ORDER BY uploaded DESC").all<PhotoMeta>();
  const { results: rx } = await env.DB.prepare(
    `SELECT photo_id, emoji, COUNT(*) AS count, MAX(CASE WHEN device_id = ?1 THEN 1 ELSE 0 END) AS mine
       FROM reactions GROUP BY photo_id, emoji ORDER BY count DESC, emoji ASC`,
  ).bind(deviceId ?? "").all<{ photo_id: string; emoji: string; count: number; mine: number }>();
  const byPhoto = new Map<string, Reaction[]>();
  for (const r of rx) {
    const arr = byPhoto.get(r.photo_id) ?? [];
    arr.push({ emoji: r.emoji, count: r.count, mine: r.mine > 0 });
    byPhoto.set(r.photo_id, arr);
  }
  return photos.map((p) => ({ ...p, reactions: byPhoto.get(p.id) ?? [] }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:run` then `npx tsc --noEmit`
Expected: the `isValidEmoji` + `reaction store` suites pass; tsc clean. (The old `likes.spec.ts` still passes here — it is removed in Task 3.)

- [ ] **Step 5: Commit**

```bash
git add worker/src/reaction-store.ts worker/test/reactions.spec.ts
git commit -m "feat(reactions): reaction-store — toggle/aggregate + emoji validation (TDD)"
```

---

### Task 3: Routes — `/react` + `reactions` in list; remove the likes feature

**Files:**
- Modify: `worker/src/photo-routes.ts`
- Delete: `worker/src/like-store.ts`, `worker/test/likes.spec.ts`
- Test: add route tests to `worker/test/reactions.spec.ts`

**Interfaces:**
- Consumes: `listPhotosWithReactions`, `toggleReaction`, `deleteReactionsFor`, `isValidEmoji` from `./reaction-store`.
- Produces: `GET /api/photos?device=X` items gain `reactions: [{emoji,count,mine}]` (and NO longer `like_count`/`liked`); `POST /api/photos/{id}/react` `{device_id, emoji}` → `{reactions}` (400 on missing device or invalid emoji); photo delete cascades reactions.

- [ ] **Step 1: Write the failing route tests** (append to `worker/test/reactions.spec.ts`)

```ts
import { SELF } from "cloudflare:test";
const OWNER = "test-owner-secret";
const BASE = "https://wall.test";
async function uploadOne() {
  const f = new FormData();
  f.append("files", new File([PNG], "cat.png", { type: "image/png" }));
  const r = await SELF.fetch(`${BASE}/api/photos`, { method: "POST", body: f });
  return (await r.json() as any).photos[0];
}
const react = (id: string, body: object) =>
  SELF.fetch(`${BASE}/api/photos/${id}/react`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("react routes", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM reactions").run(); await env.DB.prepare("DELETE FROM photos").run(); });

  it("POST /react toggles an emoji and returns the summary; GET ?device reflects it", async () => {
    const p = await uploadOne();
    const r1 = await react(p.id, { device_id: "dev-1", emoji: "😂" });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ reactions: [{ emoji: "😂", count: 1, mine: true }] });
    const listed = (await (await SELF.fetch(`${BASE}/api/photos?device=dev-1`)).json()) as any;
    expect(listed.photos[0].reactions).toEqual([{ emoji: "😂", count: 1, mine: true }]);
    const other = (await (await SELF.fetch(`${BASE}/api/photos?device=dev-2`)).json()) as any;
    expect(other.photos[0].reactions).toEqual([{ emoji: "😂", count: 1, mine: false }]);
  });

  it("rejects a missing device_id or invalid emoji with 400", async () => {
    const p = await uploadOne();
    expect((await react(p.id, { emoji: "😂" })).status).toBe(400);
    expect((await react(p.id, { device_id: "dev-1", emoji: "haha" })).status).toBe(400);
    expect((await react(p.id, { device_id: "dev-1", emoji: "" })).status).toBe(400);
  });

  it("non-POST to /react is 405", async () => {
    const p = await uploadOne();
    expect((await SELF.fetch(`${BASE}/api/photos/${p.id}/react`)).status).toBe(405);
  });

  it("deleting a photo (owner) clears its reactions", async () => {
    const p = await uploadOne();
    await react(p.id, { device_id: "dev-1", emoji: "❤️" });
    const del = await SELF.fetch(`${BASE}/api/photos/${p.id}`, { method: "DELETE", headers: { "X-Owner-Token": OWNER } });
    expect(del.status).toBe(200);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM reactions WHERE photo_id = ?").bind(p.id).first<number>("n");
    expect(n).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:run`
Expected: FAIL — `/react` 404s; `reactions` undefined on list items.

- [ ] **Step 3: Rewire `photo-routes.ts`**

(a) Replace the like-store import with the reaction-store import:
```ts
import * as reactions from "./reaction-store";
```
(remove `import * as likes from "./like-store";`).

(b) Replace `publicPhoto` with the reactions pass-through:
```ts
function publicPhoto(p: PhotoMeta & { reactions?: import("./reaction-store").Reaction[] }) {
  return {
    id: p.id,
    filename: p.filename,
    content_type: p.content_type,
    size: p.size,
    width: p.width,
    height: p.height,
    has_thumb: Boolean(p.has_thumb),
    uploaded: p.uploaded,
    ...(p.reactions !== undefined ? { reactions: p.reactions } : {}),
  };
}
```

(c) GET `/api/photos` branch → reactions list:
```ts
      if (method === "GET") {
        const device = url.searchParams.get("device");
        const photos = (await reactions.listPhotosWithReactions(env, device)).map(publicPhoto);
        return jsonOk({ photos }, env, origin);
      }
```

(d) `ITEM_RE` → route `react` instead of `like`:
```ts
const ITEM_RE = /^\/api\/photos\/([^/]+)(?:\/(raw|thumb|download|react))?$/;
```

(e) Replace the `like` action block with the `react` action (place where the `like` block was, before the raw/thumb serve logic):
```ts
    if (action === "react") {
      if (method !== "POST") return detail(405, "method not allowed", env, origin, { Allow: "POST, OPTIONS" });
      let body: Record<string, unknown>;
      try { body = await request.json(); } catch { body = {}; }
      const device = typeof body.device_id === "string" ? body.device_id.trim() : "";
      const emoji = typeof body.emoji === "string" ? body.emoji : "";
      if (!device) return detail(400, "device_id required", env, origin);
      if (!reactions.isValidEmoji(emoji)) return detail(400, "invalid emoji", env, origin);
      const summary = await reactions.toggleReaction(env, id, device, emoji);
      return jsonOk({ reactions: summary }, env, origin);
    }
```

(f) Delete-cascade: in `deletePhoto`, replace `likes.deleteLikesFor(...)` with:
```ts
  await reactions.deleteReactionsFor(env, p.id);
```

- [ ] **Step 4: Remove the superseded likes feature**

```bash
git rm worker/src/like-store.ts worker/test/likes.spec.ts
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test:run` then `npx tsc --noEmit`
Expected: all green (reactions store + route suites; the photo-routes/upload/owner suites still pass); tsc clean; no remaining reference to `like-store`.
Verify: `grep -r "like-store\|listPhotosWithLikes\|/like\b" worker/src` returns nothing.

- [ ] **Step 6: Commit**

```bash
git add worker/src/photo-routes.ts worker/test/reactions.spec.ts
git commit -m "feat(reactions): /react route + reactions in list + cascade; remove likes (TDD)"
```

---

### Task 4: Frontend — reaction chips + quick-react row + emoji input (replace ❤)

**Files:**
- Modify: `wall.js`, `wall.css`, `wall.html`

**Interfaces:**
- Consumes: `GET /api/photos?device=` (now `reactions: [{emoji,count,mine}]`); `POST /api/photos/{id}/react`.
- Produces: lightbox chips + picker; tile summary; all replacing the prior `lbLike`/`tile-likes` code.

> Context: `wall.js` already has `deviceId()` (keep it), `esc()`, `toast()`, `$()`, `PHOTO_API`, `PHOTOS`, `current`, `loadPhotos()` (with the tile builder + `newSig`), `openLightbox(p)` (sets `current = p`), `init()`. The likes increment added `postLike`/`renderLightboxLike`/`toggleCurrentLike`/`#lbLike`/`.tile-likes` and a `like_count` signature — REPLACE those.

- [ ] **Step 1: Replace the like helpers with reaction helpers** in `wall.js` (delete `postLike`, `renderLightboxLike`, `toggleCurrentLike`; keep `deviceId`):
```js
const QUICK_EMOJI = ["❤️", "😂", "‼️", "👍", "😮", "😢"];

async function postReaction(photoId, emoji) {
  const r = await fetch(`${PHOTO_API}/api/photos/${photoId}/react`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: deviceId(), emoji }),
  });
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()).reactions; // [{emoji,count,mine}]
}

// compact tile summary: up to 3 emojis + total count, e.g. "❤️😂 5"
function tileReactionHTML(reactions) {
  if (!reactions || !reactions.length) return "";
  const top = reactions.slice(0, 3).map((r) => esc(r.emoji)).join("");
  const total = reactions.reduce((n, r) => n + r.count, 0);
  return `<span class="tile-react">${top} ${total}</span>`;
}

function renderLightboxReactions(p) {
  const wrap = $("lbReactions");
  if (!wrap) return;
  const chips = (p.reactions || [])
    .map((r) => `<button type="button" class="rx-chip${r.mine ? " mine" : ""}" data-emoji="${esc(r.emoji)}">${esc(r.emoji)} <span class="rx-n">${r.count}</span></button>`)
    .join("");
  wrap.innerHTML = chips + `<button type="button" class="rx-chip rx-add" id="lbReactAdd" aria-label="Add a reaction">➕</button>`;
}

function applyReactions(photoId, reactions) {
  if (current && current.id === photoId) { current.reactions = reactions; renderLightboxReactions(current); }
  const inList = PHOTOS.find((x) => x.id === photoId);
  if (inList) inList.reactions = reactions;
  const tile = document.querySelector(`#photoGrid .tile[data-id="${photoId}"]`);
  if (tile) {
    let s = tile.querySelector(".tile-react");
    const html = tileReactionHTML(reactions);
    if (html) { if (!s) { tile.insertAdjacentHTML("beforeend", html); } else { s.outerHTML = html; } }
    else if (s) s.remove();
  }
}

async function toggleReaction(emoji) {
  if (!current) return;
  try { applyReactions(current.id, await postReaction(current.id, emoji)); }
  catch (e) { toast("Couldn't react."); }
}
```

- [ ] **Step 2: Wire the picker** — add to `wall.js` a delegated handler that runs in `init()`:
```js
function setupReactions() {
  // chip clicks (existing emoji) + add-button → quick row + emoji keyboard
  $("lbReactions").addEventListener("click", (e) => {
    const chip = e.target.closest(".rx-chip");
    if (!chip) return;
    if (chip.id === "lbReactAdd") { $("rxPicker").hidden = !$("rxPicker").hidden; return; }
    const emoji = chip.dataset.emoji;
    if (emoji) toggleReaction(emoji);
  });
  // quick row
  $("rxQuick").innerHTML = QUICK_EMOJI.map((em) => `<button type="button" class="rx-q" data-emoji="${esc(em)}">${esc(em)}</button>`).join("");
  $("rxQuick").addEventListener("click", (e) => {
    const b = e.target.closest(".rx-q");
    if (b) { $("rxPicker").hidden = true; toggleReaction(b.dataset.emoji); }
  });
  // any-emoji input: typing/pasting an emoji (phone emoji keyboard) toggles it
  $("rxInput").addEventListener("input", (e) => {
    const v = e.target.value.trim();
    e.target.value = "";
    $("rxPicker").hidden = true;
    if (v) toggleReaction(Array.from(v).slice(0, 8).join(""));
  });
}
```

- [ ] **Step 3: Render reactions on open + in the grid** — in `openLightbox(p)`, after `current = p;` add:
```js
  $("rxPicker").hidden = true;
  renderLightboxReactions(p);
```
In `loadPhotos()`'s tile template, replace the old `.tile-likes` line with the reaction summary, and update `newSig`:
```js
    tile.innerHTML =
      `<img src="${PHOTO_API}/api/photos/${esc(p.id)}/thumb" loading="lazy" alt="${esc(p.filename)}">` +
      `<span class="check" aria-hidden="true">✓</span>` +
      tileReactionHTML(p.reactions);
```
```js
    const newSig = data.map((p) => `${p.id}:${(p.reactions || []).map((r) => r.emoji + r.count).join("")}`).join(",");
```

- [ ] **Step 4: HTML** — in `wall.html`, replace the `#lbLike` button line inside `.lightbox-actions` with a reactions block placed ABOVE the actions (between `#lightboxName` and `.lightbox-actions`):
```html
    <div id="lbReactions" class="lb-reactions"></div>
    <div id="rxPicker" class="rx-picker" hidden>
      <div id="rxQuick" class="rx-quick"></div>
      <input id="rxInput" class="rx-input" inputmode="text" enterkeyhint="done" placeholder="type any emoji…" aria-label="Type any emoji">
    </div>
```
And in `init()` call `setupReactions();` (remove the old `$("lbLike")...` line).

- [ ] **Step 5: CSS** — in `wall.css`, replace the `.tile-likes`/`#lbLike` block with:
```css
.tile-react { position: absolute; left: .4rem; bottom: .4rem; background: rgba(8,8,9,.66); color: var(--paper);
  font-size: .72rem; padding: .12rem .42rem; border-radius: 999px; pointer-events: none; line-height: 1.2; }
.lb-reactions { display: flex; flex-wrap: wrap; gap: .4rem; justify-content: center; max-width: 90vw; }
.rx-chip { display: inline-flex; align-items: center; gap: .3rem; padding: .28rem .6rem; border-radius: 999px;
  border: 1px solid rgba(242,239,233,.18); background: rgba(255,255,255,.04); color: var(--paper);
  font-size: .95rem; cursor: pointer; transition: all .15s ease; }
.rx-chip:hover { border-color: rgba(212,175,55,.5); }
.rx-chip.mine { background: rgba(179,58,58,.22); border-color: var(--blood); }
.rx-chip .rx-n { font-size: .78rem; color: rgba(242,239,233,.8); }
.rx-add { font-size: .9rem; }
.rx-picker { display: flex; flex-direction: column; gap: .5rem; align-items: center; margin-top: .2rem; }
.rx-quick { display: flex; gap: .4rem; flex-wrap: wrap; justify-content: center; }
.rx-q { font-size: 1.4rem; line-height: 1; padding: .25rem .35rem; border-radius: 10px; border: 1px solid transparent;
  background: rgba(255,255,255,.04); cursor: pointer; }
.rx-q:hover { border-color: rgba(212,175,55,.5); }
.rx-input { width: min(260px, 80vw); text-align: center; padding: .5rem .7rem; border-radius: 999px;
  border: 1px solid rgba(242,239,233,.2); background: #161618; color: var(--paper); font-size: 1.1rem; }
```

- [ ] **Step 6: Verify (no frontend test framework)** — `node --check wall.js`; grep that `postReaction`, `toggleReaction`, `renderLightboxReactions`, `setupReactions`, `lbReactions`, `tile-react`, `/react`, `?device=` are present and that `lbLike`/`tile-likes`/`postLike` are GONE. Full click-through is verified live in Task 6.

- [ ] **Step 7: Commit**

```bash
git add wall.js wall.css wall.html
git commit -m "feat(reactions): frontend — chips, quick-react row, emoji input (replaces ❤ like)"
```

---

### Task 5: UAT — react round-trip (replace the like round-trip)

**Files:**
- Modify: `worker/scripts/photo_wall_uat.py`

- [ ] **Step 1: Replace the like block** in `round_once` (the `# likes:` block added previously) with:
```python
    # reactions: add two emojis, verify summary + per-device mine, remove one
    dev = f"uat-dev-{rnd}"
    rr = client.post(f"{base}/api/photos/{p['id']}/react", json={"device_id": dev, "emoji": "😂"}, timeout=15)
    ok1 = rr.status_code == 200 and rr.json().get("reactions") == [{"emoji": "😂", "count": 1, "mine": True}]
    r.check("react_add_200", ok1, rr.text[:140])
    client.post(f"{base}/api/photos/{p['id']}/react", json={"device_id": dev, "emoji": "❤️"}, timeout=15)
    listed = client.get(f"{base}/api/photos?device={dev}", timeout=15).json()["photos"]
    me = next((x for x in listed if x["id"] == p["id"]), {})
    emojis = {x["emoji"] for x in me.get("reactions", [])}
    r.check("react_reflected", emojis == {"😂", "❤️"} and all(x["mine"] for x in me["reactions"]), str(me)[:180])
    bad = client.post(f"{base}/api/photos/{p['id']}/react", json={"device_id": dev, "emoji": "haha"}, timeout=15)
    r.check("react_rejects_text", bad.status_code == 400, bad.text[:120])
    off = client.post(f"{base}/api/photos/{p['id']}/react", json={"device_id": dev, "emoji": "😂"}, timeout=15)
    r.check("react_remove", off.status_code == 200 and all(x["emoji"] != "😂" for x in off.json()["reactions"]), off.text[:140])
```

- [ ] **Step 2: Syntax-check** — `python -m py_compile worker/scripts/photo_wall_uat.py` (exit 0). Full run is Task 6.

- [ ] **Step 3: Commit**

```bash
git add worker/scripts/photo_wall_uat.py
git commit -m "test(reactions): UAT react round-trip (replaces like checks)"
```

---

### Task 6: Deploy + verify live (controller-run)

**Files:** Modify `wall-sw.js` (bump `CACHE`).

- [ ] **Step 1: Apply migration 0003 to REMOTE D1** — `npx wrangler d1 migrations apply saturfun-db --remote` (with `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID` set). Expect `0003_reactions.sql ✅`.
- [ ] **Step 2: Deploy the Worker** — `npx wrangler deploy`.
- [ ] **Step 3: Bump SW cache** — `wall-sw.js`: `const CACHE = "saturfun-wall-v7";`; commit `chore(pwa): bump SW cache v7 for reactions`.
- [ ] **Step 4: Push** — `git push origin main` + `git push origin main:gh-pages --force`.
- [ ] **Step 5: Verify live (browser)** — open the wall, open a photo, react with a quick emoji + a typed emoji; confirm chips show with counts, `mine` highlight, the tile summary, a second device sees counts but not `mine`, persistence across reload, and toggling-off removes a chip. Confirm ❤️ migrated from any prior likes. Clean up test reactions.
- [ ] **Step 6: Prod UAT** — `python scripts/photo_wall_uat.py --base https://saturfun-worker.javendean.workers.dev --owner-token <real> --rounds 2` → all green, no residue.

---

## Self-Review
- **Spec coverage:** reactions table + likes migration (T1); store + emoji validation + aggregation (T2); `/react` + `reactions` list + cascade + likes removal (T3); chips + quick row + any-emoji input + tile summary (T4); UAT (T5); deploy + live verify (T6). Multiple-per-device is enforced by the `(photo_id,device_id,emoji)` PK. Emoji input validated server-side AND escaped on render.
- **Placeholders:** none — full code in every code step; commands have expected output.
- **Type consistency:** `Reaction {emoji,count,mine}` flows identically through store → route (`{reactions}`) → UAT → frontend (`postReaction` returns `reactions`; `renderLightboxReactions`/`tileReactionHTML`/`applyReactions` consume it). `toggleReaction`(store) returns `Reaction[]`; the route wraps it as `{reactions}`. The old `like_*`/`liked`/`lbLike`/`tile-likes` symbols are all removed in T3/T4.
