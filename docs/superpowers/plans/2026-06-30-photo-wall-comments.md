# Photo Wall — Comments (+ display names) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let anyone comment on a photo (thread in the lightbox), attributed to a lightweight display name (prompted on first comment, skippable → "Someone"); owner + author can delete; a 💬 count shows under each tile.

**Architecture:** Extend the Worker + D1. Migration `0004` adds `comments` + a name-only `profiles` table. `comment-store.ts` handles comment CRUD + name upsert + counts; comments join `profiles` at read for the current name (Approach A — renaming updates past comments). New routes for the comment thread, moderation, and profile name; `GET /api/photos?device=` gains `comment_count`. Frontend: a comment thread under the reactions in the lightbox + a name prompt + a 💬 count in the under-tile meta. The profile **picture** is a later increment (this adds name only).

**Tech Stack:** Cloudflare Worker (TS) · D1 · vitest-pool-workers · vanilla JS · Python httpx UAT.

## Global Constraints
- No login — identity is the anonymous `localStorage` device id (`saturfun_device_id`, already used by reactions).
- D1: all values are **bound parameters**.
- Comments + names are public user text → **length caps** (body ≤ 500, name ≤ 40), **rate-limit** comment POST (own KV counter, like uploads), reject empty/whitespace, and **`esc()` on every render** (no XSS).
- Moderation: **owner** (`X-Owner-Token`) deletes ANY comment; **author** (matching `device_id`) deletes their OWN. Photo delete cascades comments.
- Migration `0004` is NEW (never edit `0001`–`0003`).
- Tests via `npm run test:run` in `worker/`. Bump `wall-sw.js` `CACHE` (v9 → v10) on deploy. No AI/new deps. Remote migrate: `npx wrangler d1 migrations apply saturfun-db --remote`.

## File Structure
- Create `worker/migrations/0004_comments.sql` — `comments` + `profiles(device_id,name,updated)`.
- Create `worker/src/comment-store.ts` — name/comment ops + counts + validation.
- Create `worker/test/comments.spec.ts` — store + route tests.
- Modify `worker/src/photo-routes.ts` — comment routes, profile-name routes, `comment_count` in the list, comment cascade on photo delete.
- Modify `wall.js`, `wall.css`, `wall.html` — lightbox comment thread + name prompt + name control + 💬 under-tile.
- Modify `worker/scripts/photo_wall_uat.py` — comment round-trip.
- Modify `wall-sw.js` — bump `CACHE`.

---

### Task 1: Migration 0004 + `comment-store.ts` (name + comments + counts)

**Files:** Create `worker/migrations/0004_comments.sql`, `worker/src/comment-store.ts`, `worker/test/comments.spec.ts`.

**Interfaces:**
- Produces:
  - `interface CommentRow { id: string; body: string; created: number; name: string; device_id: string }`
  - `sanitizeName(s: unknown): string | null` (trim; 1–40 chars; else null)
  - `sanitizeBody(s: unknown): string | null` (trim; 1–500 chars; else null)
  - `setName(env, deviceId, name): Promise<void>`; `getName(env, deviceId): Promise<string | null>`
  - `addComment(env, photoId, deviceId, body): Promise<CommentRow>`
  - `listComments(env, photoId): Promise<CommentRow[]>` (oldest-first; name from profiles or "Someone")
  - `getComment(env, id): Promise<{ device_id: string } | null>`
  - `deleteComment(env, id): Promise<void>`; `deleteCommentsFor(env, photoId): Promise<void>`
  - `commentCounts(env): Promise<Record<string, number>>` (photo_id → count)

- [ ] **Step 1: Migration** — `worker/migrations/0004_comments.sql`:
```sql
CREATE TABLE IF NOT EXISTS profiles (
    device_id TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    updated   REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
    id        TEXT PRIMARY KEY,
    photo_id  TEXT NOT NULL,
    device_id TEXT NOT NULL,
    body      TEXT NOT NULL,
    created   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_photo ON comments(photo_id, created);
```

- [ ] **Step 2: Failing tests** — `worker/test/comments.spec.ts`:
```ts
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { saveUpload, addPhoto } from "../src/photo-store";
import { sanitizeName, sanitizeBody, setName, getName, addComment, listComments, getComment, deleteComment, deleteCommentsFor, commentCounts } from "../src/comment-store";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
async function seed(name = "p.png") { const m = await saveUpload(env, PNG, name); await addPhoto(env, m); return m; }

describe("comment validation", () => {
  it("name: trims, caps 40, rejects empty", () => {
    expect(sanitizeName("  Jo  ")).toBe("Jo");
    expect(sanitizeName("")).toBeNull();
    expect(sanitizeName("   ")).toBeNull();
    expect(sanitizeName("x".repeat(41))).toBe("x".repeat(40));
    expect(sanitizeName(5 as any)).toBeNull();
  });
  it("body: trims, caps 500, rejects empty", () => {
    expect(sanitizeBody(" hi ")).toBe("hi");
    expect(sanitizeBody("")).toBeNull();
    expect(sanitizeBody("x".repeat(501))).toBe("x".repeat(500));
  });
});

describe("comment store", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM comments").run();
    await env.DB.prepare("DELETE FROM profiles").run();
    await env.DB.prepare("DELETE FROM photos").run();
  });

  it("adds a comment; name falls back to Someone without a profile", async () => {
    const p = await seed();
    const c = await addComment(env, p.id, "dev-1", "nice shot");
    expect(c.body).toBe("nice shot");
    expect(c.name).toBe("Someone");
    const list = await listComments(env, p.id);
    expect(list.map((x) => x.body)).toEqual(["nice shot"]);
  });

  it("joins the profile name at read (and updates retroactively)", async () => {
    const p = await seed();
    await addComment(env, p.id, "dev-1", "first");
    await setName(env, "dev-1", "Jo");
    expect((await listComments(env, p.id))[0].name).toBe("Jo");
    await setName(env, "dev-1", "Josephine"); // rename updates the existing comment's shown name
    expect((await listComments(env, p.id))[0].name).toBe("Josephine");
    expect(await getName(env, "dev-1")).toBe("Josephine");
  });

  it("lists oldest-first", async () => {
    const p = await seed();
    const a = await addComment(env, p.id, "d", "one");
    const b = await addComment(env, p.id, "d", "two");
    expect(a.created).toBeLessThanOrEqual(b.created);
    expect((await listComments(env, p.id)).map((x) => x.body)).toEqual(["one", "two"]);
  });

  it("getComment returns the author device; delete removes it", async () => {
    const p = await seed();
    const c = await addComment(env, p.id, "dev-9", "x");
    expect((await getComment(env, c.id))!.device_id).toBe("dev-9");
    await deleteComment(env, c.id);
    expect(await getComment(env, c.id)).toBeNull();
  });

  it("counts per photo + cascade delete", async () => {
    const p1 = await seed("a.png"); const p2 = await seed("b.png");
    await addComment(env, p1.id, "d", "1"); await addComment(env, p1.id, "d", "2");
    expect((await commentCounts(env))[p1.id]).toBe(2);
    expect((await commentCounts(env))[p2.id]).toBeUndefined();
    await deleteCommentsFor(env, p1.id);
    expect((await commentCounts(env))[p1.id]).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run → fails** — `cd worker && npm run test:run` → `Cannot find module '../src/comment-store'`.

- [ ] **Step 4: Implement `comment-store.ts`:**
```ts
// Comments + a name-only profile. Comments join profiles for the current display name.
import type { Env } from "./types";
type CEnv = Pick<Env, "DB">;
export interface CommentRow { id: string; body: string; created: number; name: string; device_id: string; }

export function sanitizeName(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (t.length < 1) return null;
  return t.slice(0, 40);
}
export function sanitizeBody(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (t.length < 1) return null;
  return t.slice(0, 500);
}

export async function setName(env: CEnv, deviceId: string, name: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO profiles (device_id, name, updated) VALUES (?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, updated = excluded.updated`,
  ).bind(deviceId, name, Date.now() / 1000).run();
}
export async function getName(env: CEnv, deviceId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT name FROM profiles WHERE device_id = ?").bind(deviceId).first<{ name: string }>();
  return row ? row.name : null;
}

function uuid(): string { return crypto.randomUUID().replace(/-/g, ""); }

export async function addComment(env: CEnv, photoId: string, deviceId: string, body: string): Promise<CommentRow> {
  const id = uuid();
  const created = Date.now() / 1000;
  await env.DB.prepare("INSERT INTO comments (id, photo_id, device_id, body, created) VALUES (?, ?, ?, ?, ?)")
    .bind(id, photoId, deviceId, body, created).run();
  const name = (await getName(env, deviceId)) ?? "Someone";
  return { id, body, created, name, device_id: deviceId };
}

export async function listComments(env: CEnv, photoId: string): Promise<CommentRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.body, c.created, c.device_id, COALESCE(p.name, 'Someone') AS name
       FROM comments c LEFT JOIN profiles p ON p.device_id = c.device_id
      WHERE c.photo_id = ? ORDER BY c.created ASC`,
  ).bind(photoId).all<CommentRow>();
  return results;
}

export async function getComment(env: CEnv, id: string): Promise<{ device_id: string } | null> {
  return await env.DB.prepare("SELECT device_id FROM comments WHERE id = ?").bind(id).first<{ device_id: string }>();
}
export async function deleteComment(env: CEnv, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
}
export async function deleteCommentsFor(env: CEnv, photoId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM comments WHERE photo_id = ?").bind(photoId).run();
}

export async function commentCounts(env: CEnv): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare("SELECT photo_id, COUNT(*) AS n FROM comments GROUP BY photo_id")
    .all<{ photo_id: string; n: number }>();
  const out: Record<string, number> = {};
  for (const r of results) out[r.photo_id] = r.n;
  return out;
}
```

- [ ] **Step 5: Run → passes** — `npm run test:run` (existing suites still green) + `npx tsc --noEmit`.

- [ ] **Step 6: Commit**
```bash
git add worker/migrations/0004_comments.sql worker/src/comment-store.ts worker/test/comments.spec.ts
git commit -m "feat(comments): D1 comments + name profile store + validation (TDD)"
```

---

### Task 2: Routes — comment thread, moderation, profile name, `comment_count`

**Files:** Modify `worker/src/photo-routes.ts`; add route tests to `worker/test/comments.spec.ts`.

**Interfaces:**
- Consumes `comment-store`. Produces: `GET /api/photos/{id}/comments` → `[{id,body,created,name}]`; `POST /api/photos/{id}/comments {device_id,body}` → `201 {id,body,created,name}` (400 empty, 429 rate-limited); `DELETE /api/photos/{id}/comments/{cid}` (owner OR author → 200; else 403; 404 unknown); `PUT /api/profile {device_id,name}` → `{name}` (400 bad); `GET /api/profile/{device_id}` → `{name}` or 404; `GET /api/photos?device=` items gain `comment_count`.

- [ ] **Step 1: Failing route tests** (append to `worker/test/comments.spec.ts`):
```ts
import { SELF } from "cloudflare:test";
const OWNER = "test-owner-secret";
const BASE = "https://wall.test";
async function uploadOne() {
  const f = new FormData(); f.append("files", new File([PNG], "c.png", { type: "image/png" }));
  return (await (await SELF.fetch(`${BASE}/api/photos`, { method: "POST", body: f })).json() as any).photos[0];
}
const postComment = (id: string, b: object) => SELF.fetch(`${BASE}/api/photos/${id}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

describe("comment routes", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM comments").run(); await env.DB.prepare("DELETE FROM profiles").run(); await env.DB.prepare("DELETE FROM photos").run(); });

  it("posts + lists a comment; name via profile; comment_count in the list", async () => {
    const p = await uploadOne();
    await SELF.fetch(`${BASE}/api/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: "d1", name: "Ada" }) });
    const r = await postComment(p.id, { device_id: "d1", body: "hi there" });
    expect(r.status).toBe(201);
    expect((await r.json() as any).name).toBe("Ada");
    const list = await (await SELF.fetch(`${BASE}/api/photos/${p.id}/comments`)).json() as any;
    expect(list.comments.map((c: any) => c.body)).toEqual(["hi there"]);
    const photos = await (await SELF.fetch(`${BASE}/api/photos?device=d1`)).json() as any;
    expect(photos.photos[0].comment_count).toBe(1);
  });

  it("rejects empty body (400)", async () => {
    const p = await uploadOne();
    expect((await postComment(p.id, { device_id: "d1", body: "   " })).status).toBe(400);
    expect((await postComment(p.id, { device_id: "d1" })).status).toBe(400);
  });

  it("author deletes own; a stranger cannot (403); owner deletes any", async () => {
    const p = await uploadOne();
    const c1 = await (await postComment(p.id, { device_id: "d1", body: "mine" })).json() as any;
    // stranger device → 403
    expect((await SELF.fetch(`${BASE}/api/photos/${p.id}/comments/${c1.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: "d2" }) })).status).toBe(403);
    // author → 200
    expect((await SELF.fetch(`${BASE}/api/photos/${p.id}/comments/${c1.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: "d1" }) })).status).toBe(200);
    // owner deletes any
    const c2 = await (await postComment(p.id, { device_id: "d1", body: "again" })).json() as any;
    expect((await SELF.fetch(`${BASE}/api/photos/${p.id}/comments/${c2.id}`, { method: "DELETE", headers: { "X-Owner-Token": OWNER } })).status).toBe(200);
  });

  it("PUT /profile validates the name; GET returns it", async () => {
    expect((await SELF.fetch(`${BASE}/api/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: "d1", name: "  " }) })).status).toBe(400);
    await SELF.fetch(`${BASE}/api/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: "d1", name: "Grace" }) });
    expect((await (await SELF.fetch(`${BASE}/api/profile/d1`)).json() as any).name).toBe("Grace");
  });

  it("deleting a photo cascades its comments", async () => {
    const p = await uploadOne();
    await postComment(p.id, { device_id: "d1", body: "x" });
    await SELF.fetch(`${BASE}/api/photos/${p.id}`, { method: "DELETE", headers: { "X-Owner-Token": OWNER } });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE photo_id = ?").bind(p.id).first<number>("n");
    expect(n).toBe(0);
  });
});
```

- [ ] **Step 2: Run → fails** (routes 404; `comment_count` undefined).

- [ ] **Step 3: Wire `photo-routes.ts`:**
  (a) `import * as comments from "./comment-store";`
  (b) In the `GET /api/photos` handler, after building the reactions list, merge comment counts:
```ts
      if (method === "GET") {
        const device = url.searchParams.get("device");
        const withRx = await reactions.listPhotosWithReactions(env, device);
        const counts = await comments.commentCounts(env);
        const photos = withRx.map((p) => ({ ...publicPhoto(p), comment_count: counts[p.id] ?? 0 }));
        return jsonOk({ photos }, env, origin);
      }
```
  (c) Extend `ITEM_RE` to allow a `comments` action with an optional comment id:
```ts
const ITEM_RE = /^\/api\/photos\/([^/]+)(?:\/(raw|thumb|download|react|comments))?(?:\/([^/]+))?$/;
```
and read `const commentId = m[3];` in the item handler.
  (d) Handle the `comments` action (place with the other actions):
```ts
    if (action === "comments") {
      if (method === "GET") return jsonOk({ comments: (await comments.listComments(env, id)).map((c) => ({ id: c.id, body: c.body, created: c.created, name: c.name })) }, env, origin);
      if (method === "POST") {
        if (commentId) return detail(404, "not found", env, origin);
        let body: Record<string, unknown>; try { body = await request.json(); } catch { body = {}; }
        const device = typeof body.device_id === "string" ? body.device_id.trim() : "";
        const text = comments.sanitizeBody(body.body);
        if (!device) return detail(400, "device_id required", env, origin);
        if (!text) return detail(400, "comment required", env, origin);
        const ip = request.headers.get("cf-connecting-ip") || "anon";
        const limited = await checkRateLimit(env.RATE_LIMIT, ip, Number(env.PHOTO_RATE_LIMIT_MAX) || 60, 60, "rlc");
        if (!limited.ok) return detail(429, "slow down", env, origin, { "Retry-After": String(limited.retryAfter) });
        const c = await comments.addComment(env, id, device, text);
        return jsonOk({ id: c.id, body: c.body, created: c.created, name: c.name }, env, origin, 201);
      }
      if (method === "DELETE") {
        if (!commentId) return detail(404, "not found", env, origin);
        const row = await comments.getComment(env, commentId);
        if (!row) return detail(404, "not found", env, origin);
        let body: Record<string, unknown>; try { body = await request.json(); } catch { body = {}; }
        const device = typeof body.device_id === "string" ? body.device_id : "";
        if (!isOwner(request, env) && device !== row.device_id) return detail(403, "not allowed", env, origin);
        await comments.deleteComment(env, commentId);
        return jsonOk({ ok: true }, env, origin);
      }
      return detail(405, "method not allowed", env, origin, { Allow: "GET, POST, DELETE, OPTIONS" });
    }
```
  (e) Photo delete cascade — in `deletePhoto`, add `await comments.deleteCommentsFor(env, p.id);` alongside the reactions cascade.
  (f) Add a top-level `/api/profile` route (in `handlePhotoRoute`, before/after the `/api/photos` block):
```ts
    if (path === "/api/profile") {
      if (method === "PUT") {
        let body: Record<string, unknown>; try { body = await request.json(); } catch { body = {}; }
        const device = typeof body.device_id === "string" ? body.device_id.trim() : "";
        const name = comments.sanitizeName(body.name);
        if (!device) return detail(400, "device_id required", env, origin);
        if (!name) return detail(400, "name required", env, origin);
        await comments.setName(env, device, name);
        return jsonOk({ name }, env, origin);
      }
      return detail(405, "method not allowed", env, origin, { Allow: "PUT, OPTIONS" });
    }
    { const pm = path.match(/^\/api\/profile\/([^/]+)$/);
      if (pm) {
        if (method !== "GET") return detail(405, "method not allowed", env, origin, { Allow: "GET, OPTIONS" });
        const name = await comments.getName(env, decodeURIComponent(pm[1]));
        return name ? jsonOk({ name }, env, origin) : detail(404, "no profile", env, origin);
      } }
```
  (Confirm `isOwner`, `checkRateLimit`, `jsonOk`(with an optional status arg), `detail` exist; `jsonOk` may need a status param — if it doesn't accept one, add an optional 4th/5th `status = 200` and use it for the 201.)

  Also add `DELETE` + `PUT` to the CORS allowed methods if not already present (they are for DELETE; add `PUT`).

- [ ] **Step 4: Run → passes** + `npx tsc --noEmit`. Verify CORS preflight allows `PUT`.

- [ ] **Step 5: Commit**
```bash
git add worker/src/photo-routes.ts worker/src/http.ts worker/test/comments.spec.ts
git commit -m "feat(comments): thread + moderation + profile name routes + comment_count (TDD)"
```

---

### Task 3: Frontend — comment thread + name prompt + 💬 under-tile

**Files:** Modify `wall.js`, `wall.css`, `wall.html`.

**Interfaces:** Consumes `GET/POST/DELETE .../comments`, `PUT/GET /api/profile`, `comment_count` in the list.

- [ ] **Step 1: HTML** — in `wall.html`, add a comments section inside the lightbox panel, AFTER `#lbReactions`/`#rxPicker` and BEFORE `.lightbox-actions`:
```html
    <div id="lbComments" class="lb-comments"></div>
    <form id="lbCommentForm" class="lb-comment-form">
      <input id="lbCommentInput" class="rx-input" maxlength="500" placeholder="Add a comment…" aria-label="Add a comment" autocomplete="off">
      <button type="submit" class="act small primary">Post</button>
    </form>
```
And a name sheet (near `#reactMenu`):
```html
<div id="nameSheet" hidden>
  <div id="nameSheetBackdrop"></div>
  <div id="nameSheetBar" role="dialog" aria-label="Set your name">
    <p class="ns-title">What name shows on your comments?</p>
    <input id="nameSheetInput" class="rx-input" maxlength="40" placeholder="Your name" aria-label="Your name">
    <div class="ns-actions"><button type="button" class="act small" id="nameSkip">Skip</button><button type="button" class="act small primary" id="nameSave">Save</button></div>
  </div>
</div>
```

- [ ] **Step 2: JS — profile name + comments** (in `wall.js`):
```js
const NAME_KEY = "saturfun_name";
function myName() { return localStorage.getItem(NAME_KEY) || ""; }
function timeAgo(sec) { const s = Date.now() / 1000 - sec; if (s < 60) return "now"; if (s < 3600) return Math.floor(s / 60) + "m"; if (s < 86400) return Math.floor(s / 3600) + "h"; return Math.floor(s / 86400) + "d"; }

async function loadComments(photoId) {
  const wrap = $("lbComments");
  wrap.innerHTML = `<div class="lc-empty">Loading…</div>`;
  let list = [];
  try { list = (await (await fetch(`${PHOTO_API}/api/photos/${photoId}/comments`)).json()).comments || []; } catch { wrap.innerHTML = ""; return; }
  if (!list.length) { wrap.innerHTML = `<div class="lc-empty">No comments yet.</div>`; return; }
  const canOwner = document.body.classList.contains("is-owner");
  wrap.innerHTML = list.map((c) => {
    const del = (canOwner || c.device_id === deviceId()) ? `<button class="lc-del" data-id="${esc(c.id)}" aria-label="Delete">✕</button>` : "";
    return `<div class="lc-item"><span class="lc-name">${esc(c.name)}</span> <span class="lc-body">${esc(c.body)}</span> <span class="lc-time">${timeAgo(c.created)}</span>${del}</div>`;
  }).join("");
}
async function postComment(photoId, body) {
  const r = await fetch(`${PHOTO_API}/api/photos/${photoId}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: deviceId(), body }) });
  if (r.status === 429) { toast("Slow down a moment."); return false; }
  if (!r.ok) { toast("Couldn't post."); return false; }
  return true;
}
```
Note: the comments GET returns `{id,body,created,name}` only (no `device_id`) — to know if the current device can delete, ALSO return `device_id` from the list route for the delete affordance. **Adjust Task 2 (d) GET to include `device_id: c.device_id`** in each listed comment (it's the commenter's opaque device id, not sensitive — needed for the "delete your own" button). Escape everything on render.

- [ ] **Step 3: JS — name sheet + wiring:**
```js
let pendingComment = null; // {photoId, body} awaiting a name decision
function openNameSheet() { $("nameSheetInput").value = myName(); $("nameSheet").hidden = false; $("nameSheetInput").focus(); }
function closeNameSheet() { $("nameSheet").hidden = true; }
async function saveName(name) {
  const n = (name || "").trim().slice(0, 40);
  if (n) { localStorage.setItem(NAME_KEY, n); try { await fetch(`${PHOTO_API}/api/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: deviceId(), name: n }) }); } catch {} }
}
function setupComments() {
  $("lbCommentForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("lbCommentInput"); const body = input.value.trim();
    if (!body || !current) return;
    if (!myName()) { pendingComment = { photoId: current.id, body }; input.value = ""; openNameSheet(); return; }
    input.value = "";
    if (await postComment(current.id, body)) { await loadComments(current.id); bumpCommentCount(current.id, 1); }
  });
  $("lbComments").addEventListener("click", async (e) => {
    const b = e.target.closest(".lc-del"); if (!b || !current) return;
    if (!confirm("Delete this comment?")) return;
    const r = await fetch(`${PHOTO_API}/api/photos/${current.id}/comments/${b.dataset.id}`, { method: "DELETE", headers: { "Content-Type": "application/json", ...(ownerToken() ? { "X-Owner-Token": ownerToken() } : {}) }, body: JSON.stringify({ device_id: deviceId() }) });
    if (r.ok) { await loadComments(current.id); bumpCommentCount(current.id, -1); } else toast("Couldn't delete.");
  });
  const finish = async () => { closeNameSheet(); if (pendingComment) { const pc = pendingComment; pendingComment = null; if (await postComment(pc.photoId, pc.body)) { if (current && current.id === pc.photoId) await loadComments(pc.photoId); bumpCommentCount(pc.photoId, 1); } } };
  $("nameSave").addEventListener("click", async () => { await saveName($("nameSheetInput").value); await finish(); });
  $("nameSkip").addEventListener("click", finish);
  $("nameSheetBackdrop").addEventListener("click", () => { closeNameSheet(); pendingComment = null; });
}
function bumpCommentCount(photoId, delta) {
  const p = PHOTOS.find((x) => x.id === photoId); if (!p) return;
  p.comment_count = Math.max(0, (p.comment_count || 0) + delta);
  renderTileMeta(photoId);
  lastSig = PHOTOS.map((x) => `${x.id}:${(x.reactions || []).map((r) => r.emoji + r.count).join("")}:${x.comment_count || 0}`).join(",");
}
function ownerToken() { return localStorage.getItem("saturfun_owner") || ""; }
```
(Use the ACTUAL owner-token storage key the existing code uses — read `refreshOwnerUI`/the owner flow and match it; the `ownerToken()` helper must return the same token the owner-gated delete already uses.)

- [ ] **Step 4: 💬 in the under-tile meta** — rename the under-tile renderer to include the comment count next to the reactions. Update `tileReactionsHTML`→ keep, and add the count: in the tile builder and a `renderTileMeta(photoId)`, render both the reaction chips and a `💬 N` chip when `comment_count > 0`. Concretely, change the under-tile row to `.tile-meta` containing `tileReactionsHTML(p.reactions)` + (`p.comment_count ? \`<span class="tr-chip">💬 ${p.comment_count}</span>\` : "")`, and add `renderTileMeta(photoId)` that rebuilds that row from the `PHOTOS` entry (reused by `applyReactions` and `bumpCommentCount`). Fold this into the existing `.tile-reactions`/`renderTileReactions` (rename to `.tile-meta`/`renderTileMeta`) so there is ONE under-tile row. Update the `newSig` in `loadPhotos` to include `:${p.comment_count||0}` (matching `bumpCommentCount`).

- [ ] **Step 5: openLightbox loads comments** — in `openLightbox(p)`, after rendering reactions, add `loadComments(p.id);` and `$("lbCommentInput").value = "";`. Add `setupComments();` in `init()`. Add a header name control (a small "✎ name" button that calls `openNameSheet`) — reuse an existing header slot.

- [ ] **Step 6: CSS** — add styles for `.lb-comments` (scrollable, max-height ~30vh), `.lc-item`/`.lc-name`(bold)/`.lc-body`/`.lc-time`(muted)/`.lc-del`, `.lb-comment-form` (flex row), `#nameSheet`/`#nameSheetBar` (like `#reactMenu`). Keep the design tokens.

- [ ] **Step 7: Verify + commit** — `node --check wall.js`; grep `loadComments`, `postComment`, `setupComments`, `nameSheet`, `lbComments`, `comment_count`, `renderTileMeta`. Re-read `openLightbox`, `applyReactions`, `loadPhotos`, `bumpCommentCount` for the single under-tile row + `newSig` consistency.
```bash
git add wall.js wall.css wall.html
git commit -m "feat(comments): lightbox thread + name prompt + 💬 under-tile"
```

---

### Task 4: UAT — comment round-trip

**Files:** Modify `worker/scripts/photo_wall_uat.py`.

- [ ] **Step 1:** After the reaction block in `round_once`, add:
```python
    # comments: set name, post, list, count, author-delete
    client.put(f"{base}/api/profile", json={"device_id": dev, "name": f"uat-{rnd}"}, timeout=15)
    cr = client.post(f"{base}/api/photos/{p['id']}/comments", json={"device_id": dev, "body": "uat comment"}, timeout=15)
    cid = cr.json().get("id")
    r.check("comment_post_201", cr.status_code == 201 and cr.json().get("name") == f"uat-{rnd}", cr.text[:140])
    lst = client.get(f"{base}/api/photos/{p['id']}/comments", timeout=15).json()["comments"]
    r.check("comment_listed", any(c["id"] == cid and c["body"] == "uat comment" for c in lst), str(lst)[:160])
    cc = next((x for x in client.get(f"{base}/api/photos?device={dev}", timeout=15).json()["photos"] if x["id"] == p["id"]), {})
    r.check("comment_count", cc.get("comment_count") == 1, str(cc)[:140])
    bad = client.post(f"{base}/api/photos/{p['id']}/comments", json={"device_id": dev, "body": "   "}, timeout=15)
    r.check("comment_rejects_empty", bad.status_code == 400, bad.text[:120])
    dl = client.request("DELETE", f"{base}/api/photos/{p['id']}/comments/{cid}", json={"device_id": dev}, timeout=15)
    r.check("comment_author_delete", dl.status_code == 200, dl.text[:120])
```

- [ ] **Step 2:** `python -m py_compile worker/scripts/photo_wall_uat.py`.
- [ ] **Step 3:** Commit `test(comments): UAT comment round-trip`.

---

### Task 5: Deploy + verify (controller-run)
- [ ] Apply migration 0004 to remote D1; deploy the Worker.
- [ ] Bump `wall-sw.js` `CACHE` → `saturfun-wall-v10`; commit; push main + gh-pages.
- [ ] Live browser verify: open a photo → comment thread; first comment prompts for a name (skippable); posted comment shows name·body·time; 💬 count appears under the tile; author can delete own; owner can delete any; a second device sees comments but only its own delete button. Clean up test comments.
- [ ] Prod UAT (2 rounds) → all green, no residue.

## Self-Review
- **Coverage:** comments table + name profile + validation (T1); thread/moderation/profile/comment_count routes (T2); lightbox thread + name prompt + 💬 under-tile (T3); UAT (T4); deploy (T5). Owner+author moderation; caps + rate limit + escaping. Photo-delete cascades comments.
- **Placeholders:** none in code steps; T3 Step 4 folds the comment count into the single under-tile row (rename `.tile-reactions`→`.tile-meta`).
- **Type consistency:** `CommentRow`/`{id,body,created,name(,device_id)}` flows store→route→frontend; `commentCounts` map merged as `comment_count`; the `newSig` in `loadPhotos`, `applyReactions`, and `bumpCommentCount` all include `:${comment_count}`.
- **Note for implementer:** confirm `jsonOk` supports a status arg (for 201) and the owner-token storage key; `GET .../comments` must include `device_id` per comment for the delete affordance.
