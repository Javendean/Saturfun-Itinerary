# Photo Wall — Profile Pictures (avatars) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let people set a profile picture (shown next to their name on comments). Uploaded, magic-byte validated, client-downscaled to ~256px, served by an OPAQUE `avatar_id` (never `device_id`, preserving the comment-delete privacy fix).

**Architecture:** Migration `0005` adds `avatar_id` to `profiles`. Avatar bytes live in the existing R2 bucket under `avatars/{avatar_id}`; `avatar_id` is a random opaque token that is BOTH the R2 key and the public URL handle. New routes upload + serve avatars; the comment list gains `avatar_url` (from the profile's `avatar_id`) — `device_id` is still never disclosed. Frontend: an avatar picker in the name sheet (client canvas-downscale before upload) + an avatar next to each comment.

**Tech Stack:** Cloudflare Worker (TS) · D1 · R2 · vitest-pool-workers · vanilla JS · Python httpx UAT.

## Global Constraints
- No login — anonymous `device_id`. **Avatars are served by `avatar_id`, NEVER by `device_id`** (device_id stays secret per the prior security fix).
- Validate avatar uploads by **magic bytes** (reuse `sniffImage` from `worker/src/photos.ts`), never Content-Type; per-file cap (~2 MB); reject non-images (400/415).
- D1: bound parameters. Migration `0005` is NEW (never edit `0001`–`0004`). `ALTER TABLE profiles ADD COLUMN avatar_id TEXT`.
- Tests via `npm run test:run` in `worker/`. Bump `wall-sw.js` `CACHE` (v11 → v12). No AI/new deps. Remote migrate before deploy.
- Reuse the R2 binding (`PHOTOS_BUCKET`) under an `avatars/` prefix.

## File Structure
- Create `worker/migrations/0005_avatars.sql` — `ALTER TABLE profiles ADD COLUMN avatar_id TEXT`.
- Modify `worker/src/comment-store.ts` — `setAvatar`, `getAvatarBytes`, `getAvatarId`; extend `listComments` with `avatar_url`.
- Modify `worker/src/photo-routes.ts` — `POST /api/profile/avatar` (multipart), `GET /api/avatar/{avatar_id}`, `avatar_url` in the comment list.
- Modify `worker/src/index.ts` — forward `/api/avatar/*`.
- Modify `worker/test/comments.spec.ts` — avatar store + route tests.
- Modify `wall.js`, `wall.css`, `wall.html` — avatar picker in the name sheet (client downscale) + comment avatars.
- Modify `worker/scripts/photo_wall_uat.py` — avatar round-trip.
- Modify `wall-sw.js` — bump `CACHE`.

---

### Task 1: Migration 0005 + avatar store ops

**Files:** Create `worker/migrations/0005_avatars.sql`; modify `worker/src/comment-store.ts`, `worker/test/comments.spec.ts`.

**Interfaces:**
- Produces: `setAvatar(env, deviceId, bytes: Uint8Array): Promise<{ avatar_id: string }>` (validates via `sniffImage`, stores R2 `avatars/{id}`, upserts `profiles.avatar_id`; throws on non-image); `getAvatarBytes(env, avatarId): Promise<{ body: ArrayBuffer; contentType: string } | null>`; `getAvatarId(env, deviceId): Promise<string | null>`. `listComments` now returns `...{ avatar_url: string | null }` (`/api/avatar/{avatar_id}` when the commenter has one).

- [ ] **Step 1: Migration** — `worker/migrations/0005_avatars.sql`:
```sql
ALTER TABLE profiles ADD COLUMN avatar_id TEXT;
```

- [ ] **Step 2: Failing tests** (append to `worker/test/comments.spec.ts`):
```ts
import { setAvatar, getAvatarBytes, getAvatarId } from "../src/comment-store";
// PNG constant already defined in this file.
const GIFBYTES = Uint8Array.from(atob("R0lGODlhAQABAAAAACwAAAAAAQABAAA="), (c) => c.charCodeAt(0));

describe("avatars", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM comments").run();
    await env.DB.prepare("DELETE FROM profiles").run();
    await env.DB.prepare("DELETE FROM photos").run();
  });

  it("stores an avatar, sets avatar_id, serves the bytes", async () => {
    const { avatar_id } = await setAvatar(env, "dev-1", PNG);
    expect(typeof avatar_id).toBe("string");
    expect(avatar_id.length).toBeGreaterThan(8);
    expect(await getAvatarId(env, "dev-1")).toBe(avatar_id);
    const got = await getAvatarBytes(env, avatar_id);
    expect(got).not.toBeNull();
    expect(got!.contentType).toContain("image/");
    expect(new Uint8Array(got!.body).length).toBe(PNG.length);
  });

  it("rejects a non-image (magic-byte validation)", async () => {
    await expect(setAvatar(env, "dev-1", Uint8Array.from([1, 2, 3, 4, 5]))).rejects.toBeTruthy();
  });

  it("re-upload keeps a stable avatar_id for the device", async () => {
    const a = await setAvatar(env, "dev-1", PNG);
    const b = await setAvatar(env, "dev-1", GIFBYTES);
    expect(b.avatar_id).toBe(a.avatar_id);
  });

  it("listComments includes avatar_url when the commenter has an avatar", async () => {
    const m = await saveUpload(env, PNG, "p.png"); await addPhoto(env, m);
    await addComment(env, m.id, "dev-1", "hi");
    const before = await listComments(env, m.id, "dev-1");
    expect(before[0].avatar_url).toBeNull();
    const { avatar_id } = await setAvatar(env, "dev-1", PNG);
    const after = await listComments(env, m.id, "dev-1");
    expect(after[0].avatar_url).toBe(`/api/avatar/${avatar_id}`);
  });
});
```

- [ ] **Step 3: Run → fails** (`Cannot find … setAvatar`).

- [ ] **Step 4: Implement in `comment-store.ts`.** Add the R2 binding to `CEnv` (`Pick<Env, "DB" | "PHOTOS_BUCKET">`), import `sniffImage` from `./photos`, and add:
```ts
import { sniffImage } from "./photos";

export async function setAvatar(env: CEnv, deviceId: string, bytes: Uint8Array): Promise<{ avatar_id: string }> {
  const kind = sniffImage(bytes); // { ext, mime } | null
  if (!kind) throw new Error("not an image");
  let avatarId = await getAvatarId(env, deviceId);
  if (!avatarId) avatarId = crypto.randomUUID().replace(/-/g, "");
  await env.PHOTOS_BUCKET.put(`avatars/${avatarId}`, bytes, { httpMetadata: { contentType: kind.mime } });
  await env.DB.prepare(
    `INSERT INTO profiles (device_id, name, avatar_id, updated) VALUES (?, 'Someone', ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET avatar_id = excluded.avatar_id, updated = excluded.updated`,
  ).bind(deviceId, avatarId, Date.now() / 1000).run();
  return { avatar_id: avatarId };
}

export async function getAvatarId(env: CEnv, deviceId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT avatar_id FROM profiles WHERE device_id = ?").bind(deviceId).first<{ avatar_id: string | null }>();
  return row?.avatar_id ?? null;
}

export async function getAvatarBytes(env: CEnv, avatarId: string): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const obj = await env.PHOTOS_BUCKET.get(`avatars/${avatarId}`);
  if (!obj) return null;
  return { body: await obj.arrayBuffer(), contentType: obj.httpMetadata?.contentType || "image/jpeg" };
}
```
Extend `listComments` to include `avatar_url`: add `p.avatar_id` to the SELECT and map `avatar_url: row.avatar_id ? \`/api/avatar/${row.avatar_id}\` : null`. Update the return type to include `avatar_url: string | null`.
```sql
SELECT c.id, c.body, c.created, COALESCE(p.name, 'Someone') AS name,
       (c.device_id = ?2) AS mine, p.avatar_id AS avatar_id
  FROM comments c LEFT JOIN profiles p ON p.device_id = c.device_id
 WHERE c.photo_id = ?1 ORDER BY c.created ASC, c.id ASC
```
(Confirm `sniffImage`'s actual return shape in `worker/src/photos.ts` and adapt `kind.mime`/`kind.ext` to the real property names.)

- [ ] **Step 5: Run → passes** + `npx tsc --noEmit`.
- [ ] **Step 6: Commit** — `git add worker/migrations/0005_avatars.sql worker/src/comment-store.ts worker/test/comments.spec.ts` → `feat(avatars): D1 avatar_id + R2 avatar store + comment avatar_url (TDD)`.

---

### Task 2: Routes — upload + serve avatars

**Files:** Modify `worker/src/photo-routes.ts`, `worker/src/index.ts`; add route tests to `worker/test/comments.spec.ts`.

**Interfaces:** `POST /api/profile/avatar` (multipart: `device_id` field + `avatar` file) → `{ avatar_url }` (400/415 non-image, 413 too big); `GET /api/avatar/{avatar_id}` → image bytes (immutable cache) or 404; comment list already carries `avatar_url` (Task 1).

- [ ] **Step 1: Failing route tests** (append):
```ts
describe("avatar routes", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM profiles").run(); });
  it("uploads an avatar (multipart) then serves it; comment shows avatar_url", async () => {
    const f = new FormData();
    f.append("device_id", "d1");
    f.append("avatar", new File([PNG], "a.png", { type: "image/png" }));
    const up = await SELF.fetch(`${BASE}/api/profile/avatar`, { method: "POST", body: f });
    expect(up.status).toBe(200);
    const url = (await up.json() as any).avatar_url as string;
    expect(url).toMatch(/^\/api\/avatar\//);
    const img = await SELF.fetch(`${BASE}${url}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toContain("image/");
  });
  it("rejects a non-image upload", async () => {
    const f = new FormData();
    f.append("device_id", "d1");
    f.append("avatar", new File([Uint8Array.from([1,2,3,4])], "x.bin", { type: "image/png" }));
    expect((await SELF.fetch(`${BASE}/api/profile/avatar`, { method: "POST", body: f })).status).toBe(400);
  });
  it("GET unknown avatar → 404", async () => {
    expect((await SELF.fetch(`${BASE}/api/avatar/nope`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Routes in `photo-routes.ts`:**
  (a) In `handlePhotoRoute`, add before the `/api/profile` block:
```ts
    if (path === "/api/profile/avatar") {
      if (method !== "POST") return detail(405, "method not allowed", env, origin, { Allow: "POST, OPTIONS" });
      const form = await request.formData();
      const device = String(form.get("device_id") || "").trim();
      const file = form.get("avatar");
      if (!device) return detail(400, "device_id required", env, origin);
      if (!(file instanceof File)) return detail(400, "avatar file required", env, origin);
      if (file.size > 2 * 1024 * 1024) return detail(413, "avatar too large", env, origin);
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        const { avatar_id } = await comments.setAvatar(env, device, bytes);
        return jsonOk({ avatar_url: `/api/avatar/${avatar_id}` }, env, origin);
      } catch { return detail(400, "not an image", env, origin); }
    }
    { const am = path.match(/^\/api\/avatar\/([^/]+)$/);
      if (am) {
        if (method !== "GET") return detail(405, "method not allowed", env, origin, { Allow: "GET, OPTIONS" });
        const got = await comments.getAvatarBytes(env, decodeURIComponent(am[1]));
        if (!got) return detail(404, "not found", env, origin);
        return new Response(got.body, { headers: { "Content-Type": got.contentType, "Cache-Control": "public, max-age=31536000, immutable", ...corsHeaders(origin, env) } });
      } }
```
  (Confirm `corsHeaders` import + signature; match the existing raw/thumb serving pattern for the image `Response`.)
  (b) `worker/src/index.ts` — forward `/api/profile/avatar` and `/api/avatar/*` to `handlePhotoRoute` (extend the routing condition, same as `/api/profile` was added).

- [ ] **Step 4: Run → passes** + `npx tsc --noEmit`.
- [ ] **Step 5: Commit** — `worker/src/photo-routes.ts worker/src/index.ts worker/test/comments.spec.ts` → `feat(avatars): upload + serve routes (magic-byte validated, opaque avatar_id) (TDD)`.

---

### Task 3: Frontend — avatar picker + comment avatars

**Files:** Modify `wall.js`, `wall.css`, `wall.html`.

- [ ] **Step 1: Name sheet avatar picker** — in `wall.html` `#nameSheetBar`, add above the actions:
```html
    <label class="ns-avatar"><img id="nameAvatarPreview" alt=""><span>Add a photo</span><input id="nameAvatarInput" type="file" accept="image/*" hidden></label>
```

- [ ] **Step 2: Client downscale + upload** — in `wall.js`:
```js
function downscaleImage(file, max = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(max / img.width, max / img.height, 1);
      const w = Math.round(img.width * s), h = Math.round(img.height * s);
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/jpeg", 0.85);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}
let pendingAvatarBlob = null;
async function uploadAvatar(blob) {
  const fd = new FormData();
  fd.append("device_id", deviceId());
  fd.append("avatar", blob, "avatar.jpg");
  const r = await fetch(`${PHOTO_API}/api/profile/avatar`, { method: "POST", body: fd });
  if (!r.ok) { toast("Couldn't upload the picture."); return null; }
  const url = (await r.json()).avatar_url;
  localStorage.setItem("saturfun_avatar", url);
  return url;
}
```
Wire the picker in `setupComments` (or a dedicated `setupProfile`): on `#nameAvatarInput` change → `downscaleImage(file)` → preview into `#nameAvatarPreview` + hold `pendingAvatarBlob`. On name-sheet **Save**, after `saveName`, if `pendingAvatarBlob` → `await uploadAvatar(pendingAvatarBlob)` (then clear it) before `finish()`.

- [ ] **Step 3: Comment avatars** — in `loadComments`, prepend an avatar to each item:
```js
    const av = c.avatar_url ? `<img class="lc-avatar" src="${esc(PHOTO_API + c.avatar_url)}" alt="">` : `<span class="lc-avatar lc-avatar-none" aria-hidden="true"></span>`;
```
and put `av` at the start of the `.lc-item` markup. (`c.avatar_url` is `/api/avatar/{id}` — prefix with `PHOTO_API`; escape it.)

- [ ] **Step 4: CSS** — `.ns-avatar` (round preview + label), `.lc-avatar` (22px round, `object-fit:cover`), `.lc-avatar-none` (muted circle). Design tokens.

- [ ] **Step 5: Verify + commit** — `node --check wall.js`; grep `downscaleImage`, `uploadAvatar`, `nameAvatarInput`, `lc-avatar`, `avatar_url`. Commit `wall.js wall.css wall.html` → `feat(avatars): name-sheet picker (client downscale) + comment avatars`.

---

### Task 4: UAT — avatar round-trip
- [ ] After the comment block in `round_once`, add: POST a PNG avatar (multipart, `device_id=dev`), assert 200 + `avatar_url` starts `/api/avatar/`; GET that url → 200 image; post a comment as `dev` and assert its `avatar_url` is set; reject a non-image (send raw bytes) → 400. `python -m py_compile`. Commit `test(avatars): UAT avatar round-trip`.

---

### Task 5: Deploy + verify (controller-run)
- [ ] Apply migration 0005 remote; deploy Worker; bump `wall-sw.js` `CACHE` → v12; push main + gh-pages.
- [ ] Live verify: set a name + pick a picture in the name sheet → the avatar uploads (downscaled) and shows next to your comment; a second device sees your avatar; reject a huge/non-image gracefully; **confirm the avatar URL uses `/api/avatar/{opaque}` and the comment list still carries NO `device_id`.** Clean up test comments/avatars.
- [ ] Prod UAT (2 rounds) → all green, no residue.

## Self-Review
- **Coverage:** avatar_id column + R2 store + validation (T1); upload/serve routes (T2); picker + downscale + comment avatars (T3); UAT (T4); deploy (T5). Served by opaque `avatar_id`, never `device_id` (privacy preserved). Magic-byte validated, size-capped, client-downscaled.
- **Placeholders:** none.
- **Type consistency:** `setAvatar`→`{avatar_id}`; route→`{avatar_url}`; `listComments` adds `avatar_url`; frontend `uploadAvatar`/`downscaleImage`/`c.avatar_url` consistent. `CEnv` gains `PHOTOS_BUCKET`. Confirm `sniffImage` return-shape property names against `worker/src/photos.ts`.
