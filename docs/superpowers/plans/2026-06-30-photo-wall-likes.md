# Photo Wall — Likes (Increment 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let anyone like/unlike a photo (toggle, deduped per device), show a live like count on each tile and in the lightbox.

**Architecture:** A new D1 `likes` table (composite PK `(photo_id, device_id)` = one like per device per photo). A `like-store.ts` module wraps the D1 ops. `GET /api/photos?device=X` is extended to return `like_count` + `liked` per photo via a single LEFT-JOIN query. A new `POST /api/photos/{id}/like` toggles. Photo deletion cascades to `likes`. Frontend: an anonymous `localStorage` device id, a ❤ button in the lightbox, a `❤ N` badge on tiles, counts carried by the existing 20 s auto-refresh.

**Tech Stack:** Cloudflare Worker (TypeScript) · D1 · `@cloudflare/vitest-pool-workers` (Vitest 4) · vanilla JS frontend (no build) · Python httpx UAT.

## Global Constraints
- No login / accounts — identity is an anonymous `localStorage` device UUID (`saturfun_device_id`).
- D1: **all values are bound parameters** — never string-concatenate SQL.
- Public endpoints: validate + cap; never trust client counts.
- Do not change the existing owner-token DELETE, CORS model, or photo upload routes.
- Tests run via `npm run test:run` in `worker/` (config `wrangler.test.toml`, omits `[ai]`).
- After any frontend (`wall.*`) deploy, **bump `CACHE` in `wall-sw.js`** (PWA update rule).
- No AI / no Anthropic API (keeps the no-billing constraint).
- D1 migrations are NOT auto-applied by deploy: `wrangler d1 migrations apply saturfun-db --remote`.

## File Structure
- Create `worker/migrations/0002_social.sql` — `likes` table + index (this increment only adds `likes`).
- Create `worker/src/like-store.ts` — D1 like ops + the social-augmented photo list.
- Create `worker/test/likes.spec.ts` — like-store + route tests.
- Modify `worker/src/photo-routes.ts` — extend `GET /api/photos` (counts + `liked`); add `POST .../like`; cascade likes on photo delete.
- Modify `worker/test/photo-routes.spec.ts` — only if existing GET-list assertions need `?device` tolerance (they don't — see Task 3 note).
- Modify `wall.js` — device id, like button + tile badge, counts from the list, optimistic toggle.
- Modify `wall.css` — like button + tile badge styles.
- Modify `worker/scripts/photo_wall_uat.py` — like round-trip.
- Modify `wall-sw.js` — bump `CACHE` (v5 → v6) on the frontend deploy.

---

### Task 1: D1 `likes` table (migration)

**Files:**
- Create: `worker/migrations/0002_social.sql`
- Test: covered by Task 2 (the store tests run against the migrated test D1).

**Interfaces:**
- Produces: a `likes(photo_id, device_id, created, PK(photo_id,device_id))` table + `idx_likes_photo`. The vitest harness applies all `migrations/*.sql` via `readD1Migrations`, so this table exists in tests automatically.

- [ ] **Step 1: Write the migration**

`worker/migrations/0002_social.sql`:
```sql
-- Photo likes: one row = one device's like of one photo (toggle via INSERT/DELETE).
CREATE TABLE IF NOT EXISTS likes (
    photo_id  TEXT NOT NULL,
    device_id TEXT NOT NULL,
    created   REAL NOT NULL,
    PRIMARY KEY (photo_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_likes_photo ON likes(photo_id);
```

- [ ] **Step 2: Apply to the LOCAL dev DB (for wrangler dev / UAT later)**

Run (in `worker/`): `npx wrangler d1 migrations apply saturfun-db-test --local --config wrangler.test.toml`
Expected: `0002_social.sql ✅`. (The vitest harness applies migrations itself, so no extra step for tests.)

- [ ] **Step 3: Commit**

```bash
git add worker/migrations/0002_social.sql
git commit -m "feat(social): add D1 likes table (migration 0002)"
```

---

### Task 2: `like-store.ts` — D1 like ops + augmented list

**Files:**
- Create: `worker/src/like-store.ts`
- Test: `worker/test/likes.spec.ts`

**Interfaces:**
- Consumes: `Env` from `./types` (needs `DB`); `PhotoMeta` from `./photo-store`.
- Produces:
  - `toggleLike(env, photoId, deviceId): Promise<{ liked: boolean; count: number }>`
  - `likeCount(env, photoId): Promise<number>`
  - `hasLiked(env, photoId, deviceId): Promise<boolean>`
  - `deleteLikesFor(env, photoId): Promise<void>`
  - `listPhotosWithLikes(env, deviceId: string | null): Promise<(PhotoMeta & { like_count: number; liked: boolean })[]>`

- [ ] **Step 1: Write the failing tests**

`worker/test/likes.spec.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { saveUpload, addPhoto } from "../src/photo-store";
import { toggleLike, likeCount, hasLiked, deleteLikesFor, listPhotosWithLikes } from "../src/like-store";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

async function seedPhoto(name = "p.png") {
  const m = await saveUpload(env, PNG, name);
  await addPhoto(env, m);
  return m;
}

describe("like store", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM likes").run();
    await env.DB.prepare("DELETE FROM photos").run();
  });

  it("toggles a like on then off, with an accurate count", async () => {
    const p = await seedPhoto();
    const a = await toggleLike(env, p.id, "dev-1");
    expect(a).toEqual({ liked: true, count: 1 });
    expect(await hasLiked(env, p.id, "dev-1")).toBe(true);
    const b = await toggleLike(env, p.id, "dev-1");
    expect(b).toEqual({ liked: false, count: 0 });
    expect(await hasLiked(env, p.id, "dev-1")).toBe(false);
  });

  it("dedupes — a second device adds a second like; same device does not double-count", async () => {
    const p = await seedPhoto();
    await toggleLike(env, p.id, "dev-1");
    await toggleLike(env, p.id, "dev-2");
    expect(await likeCount(env, p.id)).toBe(2);
    // dev-1 toggling off leaves dev-2's like
    await toggleLike(env, p.id, "dev-1");
    expect(await likeCount(env, p.id)).toBe(1);
  });

  it("listPhotosWithLikes returns counts + this device's liked flag", async () => {
    const p1 = await seedPhoto("a.png");
    const p2 = await seedPhoto("b.png");
    await toggleLike(env, p1.id, "dev-1");
    await toggleLike(env, p1.id, "dev-2");
    const list = await listPhotosWithLikes(env, "dev-1");
    const byId = Object.fromEntries(list.map((p) => [p.id, p]));
    expect(byId[p1.id].like_count).toBe(2);
    expect(byId[p1.id].liked).toBe(true);
    expect(byId[p2.id].like_count).toBe(0);
    expect(byId[p2.id].liked).toBe(false);
  });

  it("listPhotosWithLikes with a null device → liked is always false", async () => {
    const p = await seedPhoto();
    await toggleLike(env, p.id, "dev-1");
    const list = await listPhotosWithLikes(env, null);
    expect(list[0].like_count).toBe(1);
    expect(list[0].liked).toBe(false);
  });

  it("deleteLikesFor removes a photo's likes", async () => {
    const p = await seedPhoto();
    await toggleLike(env, p.id, "dev-1");
    await deleteLikesFor(env, p.id);
    expect(await likeCount(env, p.id)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (in `worker/`): `npm run test:run`
Expected: FAIL — `Cannot find module '../src/like-store'`.

- [ ] **Step 3: Write `like-store.ts`**

`worker/src/like-store.ts`:
```ts
// D1 ops for photo likes (one row per device per photo) + the social-augmented list.
import type { Env } from "./types";
import type { PhotoMeta } from "./photo-store";

type LikeEnv = Pick<Env, "DB">;

export async function hasLiked(env: LikeEnv, photoId: string, deviceId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS x FROM likes WHERE photo_id = ? AND device_id = ?")
    .bind(photoId, deviceId)
    .first<{ x: number }>();
  return row !== null;
}

export async function likeCount(env: LikeEnv, photoId: string): Promise<number> {
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM likes WHERE photo_id = ?")
    .bind(photoId)
    .first<number>("n");
  return n ?? 0;
}

export async function toggleLike(
  env: LikeEnv,
  photoId: string,
  deviceId: string,
): Promise<{ liked: boolean; count: number }> {
  if (await hasLiked(env, photoId, deviceId)) {
    await env.DB.prepare("DELETE FROM likes WHERE photo_id = ? AND device_id = ?").bind(photoId, deviceId).run();
    return { liked: false, count: await likeCount(env, photoId) };
  }
  await env.DB.prepare("INSERT OR IGNORE INTO likes (photo_id, device_id, created) VALUES (?, ?, ?)")
    .bind(photoId, deviceId, Date.now() / 1000)
    .run();
  return { liked: true, count: await likeCount(env, photoId) };
}

export async function deleteLikesFor(env: LikeEnv, photoId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM likes WHERE photo_id = ?").bind(photoId).run();
}

// Photos (newest first) + like_count + whether `deviceId` liked each. One query.
export async function listPhotosWithLikes(
  env: LikeEnv,
  deviceId: string | null,
): Promise<(PhotoMeta & { like_count: number; liked: boolean })[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.*,
            (SELECT COUNT(*) FROM likes l WHERE l.photo_id = p.id) AS like_count,
            (SELECT COUNT(*) FROM likes l WHERE l.photo_id = p.id AND l.device_id = ?1) AS liked_n
       FROM photos p
       ORDER BY p.uploaded DESC`,
  )
    .bind(deviceId ?? "")
    .all<PhotoMeta & { like_count: number; liked_n: number }>();
  return results.map((r) => ({ ...r, like_count: r.like_count ?? 0, liked: (r.liked_n ?? 0) > 0 }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:run`
Expected: PASS (all `like store` tests green; existing suites still green).

- [ ] **Step 5: Commit**

```bash
git add worker/src/like-store.ts worker/test/likes.spec.ts
git commit -m "feat(social): like-store — toggle/count/hasLiked + augmented list (TDD)"
```

---

### Task 3: Routes — `GET /api/photos` counts + `POST /api/photos/{id}/like` + delete cascade

**Files:**
- Modify: `worker/src/photo-routes.ts`
- Test: add to `worker/test/likes.spec.ts` (SELF.fetch route tests)

**Interfaces:**
- Consumes: `listPhotosWithLikes`, `toggleLike`, `deleteLikesFor` from `./like-store`.
- Produces: `GET /api/photos?device=X` items gain `like_count:number` + `liked:boolean`; `POST /api/photos/{id}/like` `{device_id}` → `{liked,count}`; photo `DELETE` also clears its likes.

> Note: the existing `photo-routes.spec.ts` asserts the list shape but does not assert the ABSENCE of extra fields, so adding `like_count`/`liked` does not break it. `publicPhoto` still drops `stored_name`.

- [ ] **Step 1: Write the failing route tests** (append to `worker/test/likes.spec.ts`)

```ts
import { SELF } from "cloudflare:test";

const OWNER = "test-owner-secret";
const BASE = "https://wall.test";
const fd1 = () => {
  const f = new FormData();
  f.append("files", new File([PNG], "cat.png", { type: "image/png" }));
  return f;
};
async function uploadOne() {
  const r = await SELF.fetch(`${BASE}/api/photos`, { method: "POST", body: fd1() });
  return (await r.json() as any).photos[0];
}

describe("like routes", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM likes").run();
    await env.DB.prepare("DELETE FROM photos").run();
  });

  it("POST /like toggles and returns {liked,count}; GET ?device reflects it", async () => {
    const p = await uploadOne();
    const r1 = await SELF.fetch(`${BASE}/api/photos/${p.id}/like`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "dev-1" }),
    });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ liked: true, count: 1 });

    const listed = (await (await SELF.fetch(`${BASE}/api/photos?device=dev-1`)).json()) as any;
    expect(listed.photos[0].like_count).toBe(1);
    expect(listed.photos[0].liked).toBe(true);

    // a different device does not see "liked"
    const other = (await (await SELF.fetch(`${BASE}/api/photos?device=dev-2`)).json()) as any;
    expect(other.photos[0].like_count).toBe(1);
    expect(other.photos[0].liked).toBe(false);

    // toggle off
    const r2 = await SELF.fetch(`${BASE}/api/photos/${p.id}/like`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "dev-1" }),
    });
    expect(await r2.json()).toEqual({ liked: false, count: 0 });
  });

  it("POST /like requires a device_id (400 without it)", async () => {
    const p = await uploadOne();
    const r = await SELF.fetch(`${BASE}/api/photos/${p.id}/like`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    expect(r.status).toBe(400);
  });

  it("deleting a photo (owner) clears its likes", async () => {
    const p = await uploadOne();
    await SELF.fetch(`${BASE}/api/photos/${p.id}/like`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "dev-1" }),
    });
    const del = await SELF.fetch(`${BASE}/api/photos/${p.id}`, { method: "DELETE", headers: { "X-Owner-Token": OWNER } });
    expect(del.status).toBe(200);
    const leftover = await env.DB.prepare("SELECT COUNT(*) AS n FROM likes WHERE photo_id = ?").bind(p.id).first<number>("n");
    expect(leftover).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:run`
Expected: FAIL — `/like` route 404s; `like_count`/`liked` undefined on the list.

- [ ] **Step 3: Wire the routes in `photo-routes.ts`**

(a) Add the import near the top:
```ts
import * as likes from "./like-store";
```

(b) Update `publicPhoto` to pass through optional social fields. Replace the `publicPhoto` function with:
```ts
function publicPhoto(p: PhotoMeta & { like_count?: number; liked?: boolean }) {
  return {
    id: p.id,
    filename: p.filename,
    content_type: p.content_type,
    size: p.size,
    width: p.width,
    height: p.height,
    has_thumb: Boolean(p.has_thumb),
    uploaded: p.uploaded,
    ...(p.like_count !== undefined ? { like_count: p.like_count, liked: !!p.liked } : {}),
  };
}
```

(c) In `handlePhotoRoute`, change the `GET /api/photos` branch to use the device + augmented list:
```ts
    if (path === "/api/photos") {
      if (method === "GET") {
        const device = url.searchParams.get("device");
        const photos = (await likes.listPhotosWithLikes(env, device)).map(publicPhoto);
        return jsonOk({ photos }, env, origin);
      }
      if (method === "POST") return await uploadPhotos(request, env, origin);
      return detail(405, "method not allowed", env, origin, { Allow: "GET, POST, OPTIONS" });
    }
```

(d) Add a `like` action to the item-route regex + dispatch. Change `ITEM_RE` to allow `like`:
```ts
const ITEM_RE = /^\/api\/photos\/([^/]+)(?:\/(raw|thumb|download|like))?$/;
```
and in the item branch, BEFORE the `!action` block, handle POST `/like`:
```ts
    if (action === "like") {
      if (method !== "POST") return detail(405, "method not allowed", env, origin, { Allow: "POST, OPTIONS" });
      let body: any;
      try { body = await request.json(); } catch { body = {}; }
      const device = typeof body.device_id === "string" ? body.device_id.trim() : "";
      if (!device) return detail(400, "device_id required", env, origin);
      const res = await likes.toggleLike(env, id, device);
      return jsonOk(res, env, origin);
    }
```
(Place this right after `const action = m[2];` and the existing `if (!action) { ... }` block — i.e., handle `like` before the `getPhoto`/serve logic. The existing `raw|thumb|download` handling stays unchanged below it.)

(e) Cascade likes on photo delete. In `deletePhoto(...)`, after the existing `await store.deleteFiles(...)` and before/after `store.deletePhoto(...)`, add:
```ts
  await likes.deleteLikesFor(env, p.id);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:run` then `npx tsc --noEmit`
Expected: all green; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add worker/src/photo-routes.ts worker/test/likes.spec.ts
git commit -m "feat(social): like route + list counts/liked + delete cascade (TDD)"
```

---

### Task 4: Frontend — device id, lightbox ❤, tile badge, counts via auto-refresh

**Files:**
- Modify: `wall.js`, `wall.css`
- (No HTML change: the like button + badge are JS-rendered; the lightbox already exists.)

**Interfaces:**
- Consumes: `GET /api/photos?device=` (now returns `like_count`/`liked`); `POST /api/photos/{id}/like`.
- Produces: a stable `deviceId()`; an optimistic `toggleLike(p)`; tile `❤ N` badge; lightbox heart.

- [ ] **Step 1: Add the device id + like helpers** (in `wall.js`, near the other consts)

```js
const DEVICE_KEY = "saturfun_device_id";
function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()); localStorage.setItem(DEVICE_KEY, id); }
  return id;
}
async function postLike(photoId) {
  const r = await fetch(`${PHOTO_API}/api/photos/${photoId}/like`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: deviceId() }),
  });
  if (!r.ok) throw new Error(String(r.status));
  return r.json(); // { liked, count }
}
```

- [ ] **Step 2: Send the device id with the list fetch** — in `loadPhotos`, change the fetch URL:
```js
    const r = await fetch(`${PHOTO_API}/api/photos?device=${encodeURIComponent(deviceId())}`);
```

- [ ] **Step 3: Render the tile badge** — in `loadPhotos`'s tile builder, change `tile.innerHTML` to append a badge:
```js
    tile.innerHTML =
      `<img src="${PHOTO_API}/api/photos/${esc(p.id)}/thumb" loading="lazy" alt="${esc(p.filename)}">` +
      `<span class="check" aria-hidden="true">✓</span>` +
      (p.like_count ? `<span class="tile-likes">❤ ${p.like_count}</span>` : "");
```
And ensure the change-signature includes counts so the auto-refresh re-renders when a count changes. In `loadPhotos`, change:
```js
    const newSig = data.map((p) => `${p.id}:${p.like_count || 0}`).join(",");
```

- [ ] **Step 4: Add the lightbox heart** — extend `openLightbox(p)` to set the heart state, and add a like control. In `openLightbox`, after setting `current = p;`, add:
```js
  renderLightboxLike(p);
```
Add the functions:
```js
function renderLightboxLike(p) {
  const btn = $("lbLike");
  if (!btn) return;
  btn.classList.toggle("liked", !!p.liked);
  btn.querySelector(".lb-like-count").textContent = p.like_count || 0;
}
async function toggleCurrentLike() {
  if (!current) return;
  const btn = $("lbLike");
  try {
    const res = await postLike(current.id);
    current.liked = res.liked;
    current.like_count = res.count;
    renderLightboxLike(current);
    // reflect in PHOTOS + grid badge without a full reload
    const inList = PHOTOS.find((x) => x.id === current.id);
    if (inList) { inList.liked = res.liked; inList.like_count = res.count; }
    const tile = document.querySelector(`#photoGrid .tile[data-id="${current.id}"]`);
    if (tile) {
      let b = tile.querySelector(".tile-likes");
      if (res.count) { if (!b) { b = document.createElement("span"); b.className = "tile-likes"; tile.appendChild(b); } b.textContent = `❤ ${res.count}`; }
      else if (b) b.remove();
    }
  } catch (e) { toast("Couldn't update like."); }
}
```

- [ ] **Step 5: Add the lightbox like button to the actions markup.** In `wall.html`, inside `.lightbox-actions`, add as the FIRST action:
```html
      <button class="act primary lb-like" id="lbLike"><span class="lb-heart">❤</span> <span class="lb-like-count">0</span></button>
```
And wire it in `init`:
```js
  $("lbLike").addEventListener("click", toggleCurrentLike);
```

- [ ] **Step 6: Styles** — add to `wall.css`:
```css
.tile-likes {
  position: absolute; left: .4rem; bottom: .4rem;
  background: rgba(8,8,9,.66); color: var(--paper);
  font-size: .68rem; letter-spacing: .02em; padding: .12rem .4rem;
  border-radius: 999px; pointer-events: none;
}
#lbLike { background: transparent; border-color: rgba(242,239,233,.18); color: var(--paper); }
#lbLike:hover { background: rgba(179,58,58,.16); border-color: var(--blood); color: var(--blood); }
#lbLike.liked { background: var(--blood); border-color: var(--blood); color: #fff; }
#lbLike .lb-heart { filter: grayscale(1) brightness(1.4); }
#lbLike.liked .lb-heart { filter: none; }
```

- [ ] **Step 7: Manual sanity (local)** — run the worker + a static server, open the wall, like a photo, confirm the heart fills + count increments + the tile badge appears, and a reload preserves it. (Full browser verification happens in Task 6.)

- [ ] **Step 8: Commit**

```bash
git add wall.js wall.css wall.html
git commit -m "feat(social): frontend likes — device id, lightbox heart, tile badge"
```

---

### Task 5: Extend the UAT (like round-trip)

**Files:**
- Modify: `worker/scripts/photo_wall_uat.py`

**Interfaces:**
- Consumes: `POST /api/photos/{id}/like`, `GET /api/photos?device=`.

- [ ] **Step 1: Add a like check to `round_once`** (after the PNG upload + its `created_ids.append`):
```python
    # likes: toggle on, verify count + liked via ?device, toggle off
    dev = f"uat-dev-{rnd}"
    lr = client.post(f"{base}/api/photos/{p['id']}/like", json={"device_id": dev}, timeout=15)
    r.check("like_on_200", lr.status_code == 200 and lr.json().get("liked") is True and lr.json().get("count") == 1, lr.text[:120])
    listed = client.get(f"{base}/api/photos?device={dev}", timeout=15).json()["photos"]
    me = next((x for x in listed if x["id"] == p["id"]), {})
    r.check("like_reflected", me.get("like_count") == 1 and me.get("liked") is True, str(me)[:160])
    lr2 = client.post(f"{base}/api/photos/{p['id']}/like", json={"device_id": dev}, timeout=15)
    r.check("like_off", lr2.status_code == 200 and lr2.json().get("liked") is False, lr2.text[:120])
```

- [ ] **Step 2: Run the UAT against local `wrangler dev`**

Run (in `worker/`, with `wrangler dev --config wrangler.test.toml --port 8787` running + local migrations applied):
`python scripts/photo_wall_uat.py --base http://127.0.0.1:8787 --owner-token test-owner-secret --rounds 1`
Expected: all checks pass (including the new `like_*` checks); no residue.

- [ ] **Step 3: Commit**

```bash
git add worker/scripts/photo_wall_uat.py
git commit -m "test(social): UAT like round-trip"
```

---

### Task 6: Deploy + verify live

**Files:**
- Modify: `wall-sw.js` (bump `CACHE`)

- [ ] **Step 1: Apply the migration to the REMOTE D1**

Run (in `worker/`): `npx wrangler d1 migrations apply saturfun-db --remote`
Expected: `0002_social.sql ✅`. (Set `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in the env first.)

- [ ] **Step 2: Deploy the Worker**

Run: `npx wrangler deploy`
Expected: deployed; bindings include DB + the new routes.

- [ ] **Step 3: Bump the SW cache + commit the frontend**

In `wall-sw.js`: `const CACHE = "saturfun-wall-v6";`
```bash
git add wall-sw.js
git commit -m "chore(pwa): bump SW cache v6 for likes"
```

- [ ] **Step 4: Push main + gh-pages**

```bash
git push origin main
git push origin main:gh-pages --force
```

- [ ] **Step 5: Verify live (browser)** — once Pages publishes: open the live wall, like a photo, confirm the heart fills + count + tile badge, that a second "device" (incognito / different localStorage) sees the count but not "liked", and that auto-refresh propagates a like made elsewhere. Delete any test photos created.

- [ ] **Step 6: Run the UAT against production**

Run: `python scripts/photo_wall_uat.py --base https://saturfun-worker.javendean.workers.dev --owner-token <real> --rounds 1`
Expected: all green, no residue.

---

## Self-Review

- **Spec coverage (likes slice):** `likes` table (Task 1) ✓; toggle + dedup + count (Task 2) ✓; `?device` list with `like_count`+`liked` (Tasks 2–3) ✓; `POST /like` (Task 3) ✓; photo-delete cascade (Task 3) ✓; tile badge + lightbox heart (Task 4) ✓; counts ride auto-refresh via the count-aware signature (Task 4, Step 3) ✓; bound params only ✓; tests + UAT + live verify ✓. Comments + profiles are explicitly out of this increment (separate plans).
- **Placeholders:** none — every code step has real code; commands have expected output.
- **Type consistency:** `toggleLike`→`{liked,count}` used identically in store, route, UAT, and frontend; `listPhotosWithLikes` returns `like_count`/`liked` consumed by `publicPhoto` and the frontend; `deviceId()`/`postLike()` names consistent across steps.

## Out of scope (next plans, after likes ships)
- **Comments** (table, routes create/list/delete + owner/author moderation, lightbox thread, 💬 badge, light polling while open).
- **Profiles** (profiles table + R2 avatars, `PUT /api/profile`, profile sheet, wire names/avatars into likes/comments, first-action prompt).
