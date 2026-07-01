# Photo Wall — Opening Whirlwind + Haptics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When the site/PWA opens AND there's new activity since the last visit, play a ~3s skippable "whirlwind": recent photos spiral in a vortex while recent reaction emojis streak as embers and latest comments ghost past, then the photos fly out to their real grid positions (the wall assembles), ending on a recap line. Plus: long-press to react buzzes (haptics) with a visual pop fallback. Everything ships to both the website and the PWA.

**Architecture:** A new `GET /api/activity` endpoint returns the newest photos + recent reaction emoji events + latest comments + a `latest` timestamp (no `device_id` leak — same privacy model as comments). The frontend fetches it on load, compares `latest` to a `localStorage` "last seen" marker, and if newer plays a canvas-free DOM overlay animation (GPU transforms via rAF), then updates the marker. Haptics use the Vibration API (Android; iOS has no API → visual pop fallback everywhere).

**Tech Stack:** Cloudflare Worker (TS) · D1 · vitest-pool-workers · vanilla JS (no build) · Vibration API · rAF/CSS transforms.

## Global Constraints
- No `device_id` disclosure anywhere (the activity comments must return only `{name, body, avatar_url, created}` — mirror `listComments`).
- D1: bound params. No new migration (reads only). Reuse existing tables (photos/reactions/comments/profiles).
- The whirlwind must be **skippable** (tap anywhere), **brief** (~3 s), **capped element count** (~40 DOM nodes) for mobile perf (GPU `transform` only, no layout thrash), and must NOT block or break the grid/reactions/comments/refresh/PWA underneath.
- Play ONLY when `activity.latest > localStorage["saturfun_seen"]`; on first visit (no marker) set the marker and DON'T play. Always update the marker after (played or not).
- Haptics: feature-detect `navigator.vibrate`; never assume it exists. Pair with a CSS pop so iOS gets feedback.
- Bump `wall-sw.js` `CACHE` (v13 → v14) on deploy; push main + gh-pages so BOTH the website and PWA update. No AI/new deps.

## File Structure
- Create `worker/src/activity-store.ts` — `getRecentActivity(env, limits?)`.
- Create `worker/test/activity.spec.ts` — store + route tests.
- Modify `worker/src/photo-routes.ts` — `GET /api/activity`.
- Modify `worker/src/index.ts` — forward `/api/activity`.
- Modify `wall.js`, `wall.css`, `wall.html` — haptics (long-press) + the whirlwind overlay + trigger.
- Modify `worker/scripts/photo_wall_uat.py` — `/api/activity` shape check.
- Modify `wall-sw.js` — bump `CACHE`.

---

### Task 1: Backend `GET /api/activity`

**Files:** Create `worker/src/activity-store.ts`, `worker/test/activity.spec.ts`; modify `worker/src/photo-routes.ts`, `worker/src/index.ts`.

**Interfaces:**
- Produces: `getRecentActivity(env, opts?: { photos?: number; reactions?: number; comments?: number }): Promise<{ photos: {id:string; filename:string; uploaded:number}[]; reactions: {emoji:string; created:number}[]; comments: {name:string; body:string; avatar_url:string|null; created:number}[]; latest: number }>`; `GET /api/activity` returns that object. NO `device_id` in any field.

- [ ] **Step 1: Failing tests** — `worker/test/activity.spec.ts`:
```ts
import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { saveUpload, addPhoto } from "../src/photo-store";
import { toggleReaction } from "../src/reaction-store";
import { addComment, setAvatar } from "../src/comment-store";
import { getRecentActivity } from "../src/activity-store";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
async function seed(name = "p.png") { const m = await saveUpload(env, PNG, name); await addPhoto(env, m); return m; }

describe("activity store", () => {
  beforeEach(async () => {
    for (const t of ["reactions", "comments", "profiles", "photos"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  it("returns recent photos, reactions, comments + a latest timestamp; no device_id", async () => {
    const p = await seed("a.png");
    await toggleReaction(env, p.id, "dev-1", "🔥");
    await addComment(env, p.id, "dev-1", "wow");
    const a = await getRecentActivity(env);
    expect(a.photos[0].id).toBe(p.id);
    expect(a.reactions.map((r) => r.emoji)).toContain("🔥");
    expect(a.comments[0].body).toBe("wow");
    expect(a.comments[0]).not.toHaveProperty("device_id");
    expect(a.latest).toBeGreaterThan(0);
  });

  it("comment carries the joined name + avatar_url (opaque)", async () => {
    const p = await seed();
    await addComment(env, p.id, "dev-1", "hi");
    await setAvatar(env, "dev-1", PNG);
    const a = await getRecentActivity(env);
    expect(a.comments[0].name).toBeTruthy();
    expect(a.comments[0].avatar_url).toMatch(/^\/api\/avatar\//);
  });

  it("empty wall → empty arrays, latest 0", async () => {
    const a = await getRecentActivity(env);
    expect(a.photos).toEqual([]);
    expect(a.reactions).toEqual([]);
    expect(a.comments).toEqual([]);
    expect(a.latest).toBe(0);
  });

  it("GET /api/activity returns the shape", async () => {
    const p = await seed();
    await toggleReaction(env, p.id, "d", "❤️");
    const r = await SELF.fetch("https://wall.test/api/activity");
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(Array.isArray(j.photos) && Array.isArray(j.reactions) && Array.isArray(j.comments)).toBe(true);
    expect(typeof j.latest).toBe("number");
  });
});
```

- [ ] **Step 2: Run → fails** (`Cannot find … activity-store`).

- [ ] **Step 3: Implement `activity-store.ts`:**
```ts
// Unified recent-activity feed for the opening whirlwind. Read-only; no device_id disclosed.
import type { Env } from "./types";
type AEnv = Pick<Env, "DB">;

export async function getRecentActivity(
  env: AEnv,
  opts: { photos?: number; reactions?: number; comments?: number } = {},
) {
  const nP = opts.photos ?? 12, nR = opts.reactions ?? 24, nC = opts.comments ?? 12;
  const [ph, rx, cm] = await Promise.all([
    env.DB.prepare("SELECT id, filename, uploaded FROM photos ORDER BY uploaded DESC LIMIT ?").bind(nP).all<{ id: string; filename: string; uploaded: number }>(),
    env.DB.prepare("SELECT emoji, created FROM reactions ORDER BY created DESC LIMIT ?").bind(nR).all<{ emoji: string; created: number }>(),
    env.DB.prepare(
      `SELECT c.body, c.created, COALESCE(p.name,'Someone') AS name, p.avatar_id AS avatar_id
         FROM comments c LEFT JOIN profiles p ON p.device_id = c.device_id
        ORDER BY c.created DESC LIMIT ?`,
    ).bind(nC).all<{ body: string; created: number; name: string; avatar_id: string | null }>(),
  ]);
  const photos = ph.results;
  const reactions = rx.results;
  const comments = cm.results.map((c) => ({ name: c.name, body: c.body, avatar_url: c.avatar_id ? `/api/avatar/${c.avatar_id}` : null, created: c.created }));
  const latest = Math.max(0, photos[0]?.uploaded ?? 0, reactions[0]?.created ?? 0, comments[0]?.created ?? 0);
  return { photos, reactions, comments, latest };
}
```

- [ ] **Step 4: Route** — in `photo-routes.ts` `handlePhotoRoute`, add near the other top-level `/api/...` branches:
```ts
    if (path === "/api/activity") {
      if (method !== "GET") return detail(405, "method not allowed", env, origin, { Allow: "GET, OPTIONS" });
      return jsonOk(await activity.getRecentActivity(env), env, origin);
    }
```
with `import * as activity from "./activity-store";`. In `index.ts`, forward `/api/activity` to `handlePhotoRoute` (extend the routing guard, same as `/api/avatar` / `/api/profile`).

- [ ] **Step 5: Run → passes** + `npx tsc --noEmit`.
- [ ] **Step 6: Commit** — `worker/src/activity-store.ts worker/test/activity.spec.ts worker/src/photo-routes.ts worker/src/index.ts` → `feat(whirlwind): GET /api/activity recent feed (photos+reactions+comments, no device_id) (TDD)`.

---

### Task 2: Haptics — long-press buzz + visual pop

**Files:** Modify `wall.js`, `wall.css`.

**Interfaces:** a `haptic(ms)` helper; a `popTile(tileEl)` visual; wired into the long-press react-menu trigger + reaction add.

- [ ] **Step 1: Helpers** (in `wall.js`):
```js
function haptic(ms = 12) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch {} }
function popTile(el) { if (!el) return; el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop"); }
```

- [ ] **Step 2: Wire into long-press** — in the tile long-press timer callback (where `openReactMenu(p.id)` fires after 450 ms), add `haptic(15); popTile(tile);` right before/after opening the menu, so the hold gives a buzz (Android) + a visual pop (all platforms). Also call `haptic(10)` inside `reactOn` (or the menu tap handler) when a reaction is added, for a light confirm buzz.

- [ ] **Step 3: CSS** — the pop:
```css
.tile.pop { animation: tilepop .28s ease; }
@keyframes tilepop { 0% { transform: scale(1); } 40% { transform: scale(.94); } 100% { transform: scale(1); } }
.rm-q:active { transform: scale(.9); }
```

- [ ] **Step 4: Verify + commit** — `node --check wall.js`; grep `haptic`, `popTile`, `navigator.vibrate`. Commit `wall.js wall.css` → `feat(haptics): long-press vibrate + visual pop (progressive; iOS gets the pop)`.

---

### Task 3: The whirlwind opening reveal

**Files:** Modify `wall.js`, `wall.css`, `wall.html`.

**Interfaces:** `maybePlayWhirlwind()` (fetch activity, gate on new-since-seen, animate); consumes `/api/activity` + the rendered grid tiles (for the fly-to finale). Runs after `loadPhotos()` in `init`.

- [ ] **Step 1: Overlay markup** — in `wall.html`, add before `#toast`:
```html
<div id="whirl" hidden aria-hidden="true"><div id="whirlStage"></div><div id="whirlRecap"></div><div id="whirlSkip">tap to skip</div></div>
```

- [ ] **Step 2: Trigger + gate** (in `wall.js`, called at the end of `init` after `loadPhotos()`):
```js
const SEEN_KEY = "saturfun_seen";
async function maybePlayWhirlwind() {
  let act;
  try { act = await (await fetch(`${PHOTO_API}/api/activity`)).json(); } catch { return; }
  if (!act || !act.latest) return;
  const seen = parseFloat(localStorage.getItem(SEEN_KEY) || "0");
  localStorage.setItem(SEEN_KEY, String(act.latest)); // always advance the marker
  if (!seen) return;                 // first visit: mark, don't play
  if (act.latest <= seen) return;    // nothing new
  const newCounts = {
    photos: act.photos.filter((p) => p.uploaded > seen).length,
    reactions: act.reactions.filter((r) => r.created > seen).length,
    comments: act.comments.filter((c) => c.created > seen).length,
  };
  if (newCounts.photos + newCounts.reactions + newCounts.comments === 0) return;
  playWhirlwind(act, newCounts);
}
```

- [ ] **Step 3: The animation** — implement `playWhirlwind(act, newCounts)` in `wall.js`. Requirements (a fresh implementer has latitude on the exact math/easing, but MUST hit these beats; keep it GPU-only `transform`/`opacity`, ~40 nodes max, ~3 s, skippable):
  - Show `#whirl` (fixed, full-screen, ink background ~96% opaque, above everything).
  - Build up to ~10 photo thumbnails (`<img src=".../thumb">` from `act.photos`), ~20 emoji `<span>` embers (from `act.reactions`), and 3–4 faint comment ghosts (`esc(name)+": "+esc(body)` from `act.comments`) into `#whirlStage`, each absolutely positioned, initial `transform` scattered near the viewport edges.
  - **Vortex (≈0–1.6 s):** with a `requestAnimationFrame` loop, move photos + embers along a spiral toward center — `angle += speed`, `radius` eases from large→small; apply `translate3d(x,y,0) rotate(a) scale(s)`; embers get a blood/gold glow (`filter: drop-shadow`) and trail slightly; comment ghosts drift across at low opacity.
  - **Release/assemble (≈1.6–2.6 s):** for each whirlwind photo whose id matches a rendered grid tile (`#photoGrid .tile-card[data-id=...]`), read the tile's `getBoundingClientRect()` and animate that photo from center to the tile's position+size (transition transform), then fade the photo out as it lands; fade `#whirl` to transparent (revealing the real grid); embers fly outward + fade.
  - **Recap (≈2.2–3 s):** fade `#whirlRecap` in with e.g. `✦ ${newCounts.reactions} reactions · ${newCounts.comments} comments · ${newCounts.photos} photos since you were here` (omit zero parts), then fade out.
  - End: remove/hide `#whirl`, clear `#whirlStage`. Guard so it can't run twice concurrently.
  - **Skip:** a click/touch on `#whirl` (or the `#whirlSkip` hint) immediately cancels the rAF loop, hides the overlay, and reveals the grid.
  - Respect `prefers-reduced-motion`: if set, skip the animation (just advance the marker).

- [ ] **Step 4: Wire** — call `maybePlayWhirlwind()` at the end of `init()` AFTER the first `loadPhotos()` resolves (so the grid tiles exist for the fly-to finale). It must not block `loadPhotos`/interaction if it errors.

- [ ] **Step 5: CSS** — `#whirl` (fixed inset 0, z-index above lightbox/menus e.g. 70, ink bg, `display:flex`, `[hidden]` hides it), `#whirlStage` (relative, full size), `.whirl-photo` (absolute, ~92px, rounded, `will-change:transform`), `.whirl-ember` (absolute, ~1.6rem, blood/gold `drop-shadow`), `.whirl-ghost` (absolute, faint paper text, serif), `#whirlRecap` (centered gold serif line, hidden→fade), `#whirlSkip` (bottom, muted small). Use design tokens.

- [ ] **Step 6: Verify + commit** — `node --check wall.js`; grep `maybePlayWhirlwind`, `playWhirlwind`, `whirlStage`, `SEEN_KEY`, `requestAnimationFrame`, `prefers-reduced-motion`. Commit `wall.js wall.css wall.html` → `feat(whirlwind): opening reveal on new activity (vortex → assemble + recap, skippable)`.

---

### Task 4: UAT + deploy + verify (controller-run)
- [ ] **UAT:** add to `round_once` a check that `GET /api/activity` returns 200 with `photos`/`reactions`/`comments` arrays + numeric `latest`, and that no comment carries `device_id`. `py_compile`. Commit `test(whirlwind): UAT /api/activity shape`.
- [ ] Deploy the Worker (no migration — reads only). Bump `wall-sw.js` `CACHE` → v14; commit; push main + gh-pages.
- [ ] Live verify on BOTH the website and (SW-updated) PWA: with a stale `saturfun_seen`, opening replays the whirlwind (vortex → photos land in the grid → recap); tap-to-skip works; `prefers-reduced-motion` skips; long-press buzzes on Android (visual pop everywhere); a second open with no new activity does NOT replay. Confirm the grid/reactions/comments still work after. Prod UAT (2 rounds) green.

## Self-Review
- **Coverage:** activity endpoint (T1); haptics + pop (T2); whirlwind trigger + animation (T3); UAT + deploy + both-surface verify (T4). New-activity gate via `localStorage` marker vs `activity.latest`. No device_id in activity. Skippable + reduced-motion + perf-capped.
- **Placeholders:** T3 Step 3 intentionally gives the implementer latitude on easing/curve but pins the required beats, node budget, duration, skip, and reduced-motion — not a placeholder.
- **Type consistency:** `getRecentActivity` → `{photos,reactions,comments,latest}` consumed identically by the route, UAT, and `maybePlayWhirlwind`; `avatar_url` opaque; `SEEN_KEY` marker written once per open.
