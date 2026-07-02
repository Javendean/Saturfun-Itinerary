# SP2 — Personalized Manga Harvester Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** In the Panels tab, let anyone upload reference panels from their phone, tag what they like about a panel (aspect tags + note), and see + tune an editable per-user taste profile.

**Architecture:** Reuse the Worker's proven image pipeline (`sniffImage` magic-byte validation + R2 under a `panels/` prefix, mirroring the avatar ops) and the shared per-user taste model (D1). Migration `0006` adds `manga_panels` + `taste_profiles` + `taste_signals` (the latter two are the shared model SP4 also uses). Frontend adds upload + a personal-panels grid + a tag sheet + a taste editor to `manga.html`.

**Tech Stack:** Cloudflare Worker (TS) · D1 · R2 (`PHOTOS_BUCKET`) · vitest-pool-workers · vanilla JS. Identity = anonymous `device_id` (localStorage `saturfun_device_id`).

## Global Constraints
- Uploads validated by **magic bytes** (`sniffImage`), size-capped, stored in R2 under generated keys; the R2 key is never exposed to clients.
- D1: all values are **bound parameters**; migration `0006` is NEW (never edit `0001`–`0005`).
- `device_id` is never disclosed to other clients; taste + signals are per-device (the comment-feature privacy rule).
- All server-rendered user text (notes, taste data) is **escaped** on render.
- Ships to website + PWA (bump `sw.js` `CACHE`, push main + gh-pages).
- Reuse exact existing helpers: `sniffImage(head): {contentType,ext}|null` (photos.ts); `jsonOk(obj,env,origin,status?)`, `detail(status,msg,env,origin,extra?)`, `isOwner(req,env)` (photo-routes.ts); `checkRateLimit(kv,ip,max,windowSeconds,prefix)` (rate-limit.ts); bindings `DB`,`PHOTOS_BUCKET`,`RATE_LIMIT` on `Env` (types.ts). Model panel upload on the avatar upload route (`POST /api/profile/avatar`, photo-routes.ts:88) + avatar ops (comment-store.ts:80–102).

## File Structure
- Create `worker/migrations/0006_manga.sql` — `manga_panels` + `taste_profiles` + `taste_signals`.
- Create `worker/src/manga-store.ts` — panel R2/D1 ops + tag signal + taste get/set + validation.
- Create `worker/test/manga.spec.ts` — store + route tests.
- Modify `worker/src/photo-routes.ts` — `/api/manga/*` + `/api/taste/*` routes.
- Modify `worker/src/index.ts` — route `/api/manga` + `/api/taste` to `handlePhotoRoute`.
- Modify `manga.html` — deviceId + upload control + personal-panels grid + tag sheet + taste editor (+ CSS).
- Modify `worker/scripts/photo_wall_uat.py` — manga round-trip.
- Modify `sw.js` — bump `CACHE`.

---

### Task 1: Migration 0006 + `manga-store.ts` (TDD)

**Files:** Create `worker/migrations/0006_manga.sql`, `worker/src/manga-store.ts`, `worker/test/manga.spec.ts`.

**Interfaces:**
- Produces:
  - `interface Panel { id: string; content_type: string; created: number }`
  - `const ASPECTS: string[]` = `["linework","composition","inking","shading","negative_space","dynamism","mood","expression","texture"]`
  - `isValidAspects(a: unknown): string[]` — filters to the allowed vocab, dedupes, caps at 9; returns `[]` if none valid
  - `savePanel(env, deviceId, bytes): Promise<{ id: string }>` (sniffImage→throw on non-image; R2 put `panels/{id}`; insert row)
  - `listPanels(env, deviceId): Promise<Panel[]>` (newest first)
  - `getPanelBytes(env, id): Promise<{ body: ArrayBuffer; contentType: string } | null>`
  - `tagPanel(env, deviceId, panelId, aspects: string[], note: string): Promise<void>` (insert `taste_signals` domain='manga')
  - `getTaste(env, deviceId, domain): Promise<any | null>` (parsed JSON of `taste_profiles.data`)
  - `setTaste(env, deviceId, domain, data: any): Promise<void>` (upsert)

- [ ] **Step 1: Migration** `worker/migrations/0006_manga.sql`:
```sql
CREATE TABLE IF NOT EXISTS manga_panels (
    id           TEXT PRIMARY KEY,
    device_id    TEXT NOT NULL,
    content_type TEXT NOT NULL,
    created      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_manga_panels_device ON manga_panels(device_id, created);

CREATE TABLE IF NOT EXISTS taste_profiles (
    device_id TEXT NOT NULL,
    domain    TEXT NOT NULL,
    data      TEXT NOT NULL,
    updated   REAL NOT NULL,
    PRIMARY KEY (device_id, domain)
);
CREATE TABLE IF NOT EXISTS taste_signals (
    id         TEXT PRIMARY KEY,
    device_id  TEXT NOT NULL,
    domain     TEXT NOT NULL,
    target_ref TEXT,
    signal     TEXT NOT NULL,
    created    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_taste_signals ON taste_signals(device_id, domain, created);
```

- [ ] **Step 2: Failing tests** `worker/test/manga.spec.ts` — cover: `isValidAspects` (keeps valid vocab, drops junk, dedupes, caps, rejects non-array); `savePanel` stores + `getPanelBytes` serves; `savePanel` throws on a non-image (`Uint8Array.from([1,2,3,4])`); `listPanels` newest-first + only that device's panels; `tagPanel` writes a `taste_signals` row with the aspects+note; `getTaste`/`setTaste` upsert round-trip (parse/stringify JSON). Use `env`/`SELF` from `cloudflare:test`; a 1×1 PNG constant. (Write real-value assertions; harness auto-applies migrations.)

- [ ] **Step 3: Run → fails** (`cd worker && npm run test:run` — module missing).

- [ ] **Step 4: Implement `manga-store.ts`** (mirror comment-store's avatar ops):
```ts
import type { Env } from "./types";
import { sniffImage } from "./photos";
type MEnv = Pick<Env, "DB" | "PHOTOS_BUCKET">;
export interface Panel { id: string; content_type: string; created: number; }
export const ASPECTS = ["linework","composition","inking","shading","negative_space","dynamism","mood","expression","texture"];
const ASPECT_SET = new Set(ASPECTS);
function uuid() { return crypto.randomUUID().replace(/-/g, ""); }

export function isValidAspects(a: unknown): string[] {
  if (!Array.isArray(a)) return [];
  const out: string[] = [];
  for (const x of a) { if (typeof x === "string" && ASPECT_SET.has(x) && out.indexOf(x) === -1) out.push(x); if (out.length >= 9) break; }
  return out;
}

export async function savePanel(env: MEnv, deviceId: string, bytes: Uint8Array): Promise<{ id: string }> {
  const kind = sniffImage(bytes);
  if (!kind) throw new Error("not an image");
  const id = uuid();
  await env.PHOTOS_BUCKET.put(`panels/${id}`, bytes, { httpMetadata: { contentType: kind.contentType } });
  await env.DB.prepare("INSERT INTO manga_panels (id, device_id, content_type, created) VALUES (?, ?, ?, ?)")
    .bind(id, deviceId, kind.contentType, Date.now() / 1000).run();
  return { id };
}
export async function listPanels(env: MEnv, deviceId: string): Promise<Panel[]> {
  const { results } = await env.DB.prepare("SELECT id, content_type, created FROM manga_panels WHERE device_id = ? ORDER BY created DESC")
    .bind(deviceId).all<Panel>();
  return results;
}
export async function getPanelBytes(env: MEnv, id: string): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const obj = await env.PHOTOS_BUCKET.get(`panels/${id}`);
  if (!obj) return null;
  return { body: await obj.arrayBuffer(), contentType: obj.httpMetadata?.contentType || "application/octet-stream" };
}
export async function tagPanel(env: MEnv, deviceId: string, panelId: string, aspects: string[], note: string): Promise<void> {
  await env.DB.prepare("INSERT INTO taste_signals (id, device_id, domain, target_ref, signal, created) VALUES (?, ?, 'manga', ?, ?, ?)")
    .bind(uuid(), deviceId, panelId, JSON.stringify({ aspects, note }), Date.now() / 1000).run();
}
export async function getTaste(env: MEnv, deviceId: string, domain: string): Promise<any | null> {
  const row = await env.DB.prepare("SELECT data FROM taste_profiles WHERE device_id = ? AND domain = ?").bind(deviceId, domain).first<{ data: string }>();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}
export async function setTaste(env: MEnv, deviceId: string, domain: string, data: any): Promise<void> {
  await env.DB.prepare("INSERT INTO taste_profiles (device_id, domain, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(device_id, domain) DO UPDATE SET data = excluded.data, updated = excluded.updated")
    .bind(deviceId, domain, JSON.stringify(data ?? {}), Date.now() / 1000).run();
}
```

- [ ] **Step 5: Run → passes** + `npx tsc --noEmit`.
- [ ] **Step 6: Commit** — `git add worker/migrations/0006_manga.sql worker/src/manga-store.ts worker/test/manga.spec.ts` → `feat(manga): D1 panels + shared taste tables + store (TDD)`.

---

### Task 2: Routes — `/api/manga/*` + `/api/taste/*` (TDD)

**Files:** Modify `worker/src/photo-routes.ts`, `worker/src/index.ts`; add route tests to `worker/test/manga.spec.ts`.

**Interfaces:** `POST /api/manga/panels` (multipart `device_id` + `panel` file) → `{id, url}` (400 no device/non-image, 413 too big, 429 rate-limited); `GET /api/manga/panels?device=` → `{panels:[{id,content_type,created,url}]}`; `GET /api/manga/panels/{id}/raw` → bytes; `POST /api/manga/panels/{id}/tag` `{device_id,aspects,note}` → `{ok:true}` (400 no device/empty aspects); `GET /api/taste/{domain}?device=` → `{data}`; `PUT /api/taste/{domain}` `{device_id,data}` → `{ok:true}`.

- [ ] **Step 1: Failing route tests** (append) — cover: upload panel (multipart) → 200 + `url` starts `/api/manga/panels/`; GET raw serves image; non-image upload → 400; non-multipart → 400; list returns the device's panels with `url`; tag with valid aspects → 200 + a `taste_signals` row exists, empty/invalid aspects → 400, missing device → 400; PUT taste then GET taste round-trips; GET taste for an unknown device → `{data:null}`.

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Wire `photo-routes.ts`** — `import * as manga from "./manga-store";`. Add a `PANEL_MAX_BYTES = 8 * 1024 * 1024` const. In `handlePhotoRoute`, add branches (model the upload on the avatar route at L88 — Content-Length precheck → 413; `try{form=await request.formData()}catch{→400}`; `device_id` field required → 400; `panel` File required → 400; `file.size > PANEL_MAX_BYTES` → 413; rate-limit `checkRateLimit(env.RATE_LIMIT, ip, Number(env.PHOTO_RATE_LIMIT_MAX)||60, 60, "rlm")` → 429; `savePanel` in try/catch → 400 "not an image"):
```ts
    if (path === "/api/manga/panels") {
      if (method === "GET") {
        const device = url.searchParams.get("device") || "";
        const panels = (await manga.listPanels(env, device)).map((p) => ({ ...p, url: `/api/manga/panels/${p.id}/raw` }));
        return jsonOk({ panels }, env, origin);
      }
      if (method === "POST") { /* multipart upload per above → jsonOk({ id, url: `/api/manga/panels/${id}/raw` }) */ }
      return detail(405, "method not allowed", env, origin, { Allow: "GET, POST, OPTIONS" });
    }
    { const mm = path.match(/^\/api\/manga\/panels\/([^/]+)(?:\/(raw|tag))?$/);
      if (mm) {
        const id = mm[1], action = mm[2];
        if (action === "raw") {
          if (method !== "GET") return detail(405, "method not allowed", env, origin, { Allow: "GET, OPTIONS" });
          const got = await manga.getPanelBytes(env, id);
          if (!got) return detail(404, "not found", env, origin);
          return new Response(got.body, { headers: { "Content-Type": got.contentType, "Cache-Control": "public, max-age=31536000, immutable", ...corsHeaders(env, origin) } });
        }
        if (action === "tag") {
          if (method !== "POST") return detail(405, "method not allowed", env, origin, { Allow: "POST, OPTIONS" });
          let body: Record<string, unknown>; try { body = await request.json(); } catch { body = {}; }
          const device = typeof body.device_id === "string" ? body.device_id.trim() : "";
          const aspects = manga.isValidAspects(body.aspects);
          const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
          if (!device) return detail(400, "device_id required", env, origin);
          if (!aspects.length && !note) return detail(400, "aspects or note required", env, origin);
          await manga.tagPanel(env, device, id, aspects, note);
          return jsonOk({ ok: true }, env, origin);
        }
        return detail(404, "not found", env, origin);
      } }
    { const tm = path.match(/^\/api\/taste\/([a-z]+)$/);
      if (tm) {
        const domain = tm[1];
        if (method === "GET") { const device = url.searchParams.get("device") || ""; return jsonOk({ data: await manga.getTaste(env, device, domain) }, env, origin); }
        if (method === "PUT") {
          let body: Record<string, unknown>; try { body = await request.json(); } catch { body = {}; }
          const device = typeof body.device_id === "string" ? body.device_id.trim() : "";
          if (!device) return detail(400, "device_id required", env, origin);
          await manga.setTaste(env, device, domain, body.data ?? {});
          return jsonOk({ ok: true }, env, origin);
        }
        return detail(405, "method not allowed", env, origin, { Allow: "GET, PUT, OPTIONS" });
      } }
```
   (Confirm `corsHeaders` is imported/available in photo-routes.ts — it is used by the avatar serve route. Use the exact same signature.)

- [ ] **Step 4: `index.ts` routing** — add to the guard that dispatches to `handlePhotoRoute`: `|| url.pathname.startsWith("/api/manga") || url.pathname.startsWith("/api/taste")`.

- [ ] **Step 5: Run → passes** + `npx tsc --noEmit`.
- [ ] **Step 6: Commit** — `worker/src/photo-routes.ts worker/src/index.ts worker/test/manga.spec.ts` → `feat(manga): upload/list/serve/tag panel routes + taste get/put (TDD)`.

---

### Task 3: Frontend — Panels tab (upload + my-panels grid + tag sheet + taste editor)

**Files:** Modify `manga.html`.

**Interfaces:** consumes the Task-2 routes. `manga.html` currently hydrates the shared corpus into `#panel-grid` via an inline module (lines ~208–256) and does NOT load wall.js, so add its own `deviceId()`.

- [ ] **Step 1: device id + API base** — in manga.html's inline module (or a new one), add:
```js
const MANGA_API = (location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.hostname === "") ? "http://127.0.0.1:8787" : "https://saturfun-worker.javendean.workers.dev";
const DEVICE_KEY = "saturfun_device_id";
function deviceId() { let id = localStorage.getItem(DEVICE_KEY); if (!id) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())+Math.random()); localStorage.setItem(DEVICE_KEY, id); } return id; }
function esc(s){ return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
```

- [ ] **Step 2: "My reference panels" section + upload** — add a new `.vault-section` above/below "Recent finds":
  - An "＋ Upload a panel" button + hidden `<input type="file" accept="image/*">`.
  - On file pick: client-downscale to ~1200px max (canvas → JPEG blob, quality .85) to bound R2 size, then `POST /api/manga/panels` (multipart `device_id`+`panel`). On success, refresh the personal grid.
  - A `#my-panels` grid rendering `GET /api/manga/panels?device=` — each panel `<img src="${MANGA_API}${p.url}">` in a `.panel-card`, with a "♡ What I like" button.
  - Escape everything; show a toast/inline status on upload.

- [ ] **Step 3: Tag sheet** — clicking "What I like" on a panel opens a small sheet (reuse the dark bottom-sheet look): the 9 `ASPECTS` as toggle chips + an optional note textarea + Save → `POST /api/manga/panels/{id}/tag {device_id, aspects, note}`. Confirm with a toast. (Hardcode the 9 aspect labels in the frontend; keep in sync with the store's `ASPECTS`.)

- [ ] **Step 4: Editable taste view** — a "Your taste" panel: on load `GET /api/taste/manga?device=`; render editable controls — aspect weight sliders/toggles (the 9 aspects), a "pinned artists/series" text list, a "current focus" text field. On change (debounced) `PUT /api/taste/manga {device_id, data:{weights, pins, focus}}`. Seed sensible defaults if `data` is null. Escape rendered values.

- [ ] **Step 5: Styling** — dark, using the shared tokens (var(--ink)/--card/--paper/--gold/--blood). Reuse `.panel-grid`/`.panel-card` look; add `.aspect-chip`, taste-editor styles. Ensure the section clears the bottom tab bar (the body already has `has-tabbar` padding from the shell).

- [ ] **Step 6: Verify** — `node --check` is N/A (HTML); confirm the inline module parses (no syntax error) by loading locally is not possible headless — instead grep that `deviceId`, `MANGA_API`, `/api/manga/panels`, `/api/taste/manga`, `aspect` are present and the module has balanced braces. Full behavior verified live in Task 4.
- [ ] **Step 7: Commit** — `manga.html` → `feat(manga): Panels-tab upload + my-panels grid + tag sheet + editable taste`.

---

### Task 4: UAT + deploy + verify (controller-run)
- [ ] **UAT:** add a manga round-trip to `photo_wall_uat.py`: upload a PNG panel (multipart) → 200 + `url`; GET the url → 200 image; tag it (`aspects:["linework"],note:"x"`) → 200; PUT taste `{data:{focus:"inking"}}` then GET → data round-trips; non-image panel → 400. `py_compile`. Commit.
- [ ] Apply migration 0006 to remote D1; deploy the Worker; bump `sw.js` `CACHE`; push main + gh-pages.
- [ ] Live-verify (chrome-devtools) on the Panels tab: upload a panel from a file → it appears in "My reference panels"; open "What I like" → tag aspects + note → saved; edit taste → persists across reload; a second device doesn't see device_id leaked; grid + tab bar coexist. Clean up test panels (delete via a temp owner path or D1 — only test artifacts). Prod UAT green.

## Self-Review
- **Coverage:** panels table + shared taste tables + store + validation (T1); upload/serve/tag/taste routes + index routing (T2); Panels-tab upload + grid + tag sheet + taste editor (T3); UAT + deploy + verify (T4). Magic-byte + size-cap + rate-limit on upload; device_id never returned; escaping on render; migration 0006 new.
- **Placeholders:** the POST-upload body of the `/api/manga/panels` route is described (mirror the avatar route) rather than fully spelled — the implementer must copy the avatar upload shape exactly (Content-Length precheck, formData guard, file check, size cap, rate-limit, savePanel try/catch). This is a precise directive, not a vague one.
- **Type/name consistency:** `Panel`/`ASPECTS`/`isValidAspects`/`savePanel`/`listPanels`/`getPanelBytes`/`tagPanel`/`getTaste`/`setTaste` used consistently store→routes→UAT; `taste_signals` domain='manga'; `/api/taste/{domain}` generic (SP4 reuses with domain='itinerary'); frontend `deviceId()`/`MANGA_API` consistent.
