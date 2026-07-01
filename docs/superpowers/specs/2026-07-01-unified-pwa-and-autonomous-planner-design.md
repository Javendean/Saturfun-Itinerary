# Saturfun — Unified PWA + Autonomous Planner + Personal Harvester — Design Spec

**Date:** 2026-07-01
**Status:** Approved (design) — pending user review before implementation planning
**Scope:** Centralize the whole site into one PWA and add two autonomous, taste-driven features. Four sub-projects, built in order; each gets its own implementation plan + subagent-driven build.

---

## 1. Overview & goals

Today Saturfun is **four standalone pages with no cross-links** — `index.html` (Brooklyn itinerary, light theme), `wall.html` (photo wall, the only current PWA, dark), `panels.html` + `manga.html` (manga panel harvester, dark). They inline their own CSS and duplicate design tokens. The Cloudflare Worker backs the photo wall (D1 + R2 + KV + Workers AI) and a visitor chat.

This project delivers, in order:

1. **Unified PWA shell** — one installable app: one manifest, one service worker, a shared dark theme, and a bottom tab bar across all features.
2. **Harvester: phone-native + personalized** — upload reference panels from your phone, tag what you like, and a per-user editable taste profile.
3. **Web Push** — reach users outside the app (VAPID, server-stored subscriptions, SW push handler).
4. **Autonomous itinerary planner** — a scheduled Claude session generates new stop ideas, learns from your feedback, and pushes you a digest when it has ideas to review.

### Unifying idea
Sub-projects 2 and 4 are the **same machine**: a per-user **taste model** + a feedback loop + Claude curation. The harvester learns *what you want to draw*; the planner learns *where you want to go*. They share one pattern (§3), so one design powers both.

### Non-goals (YAGNI)
- Rewriting the itinerary into a single-page app (the 222 KB page is wrapped + re-themed, not rebuilt).
- Real accounts/login (identity stays the anonymous `device_id` + optional name/avatar already in D1).
- Region/annotation feedback on panels (tags + note now; annotation is a later enhancement).
- A third-party push service (standard Web Push only).
- Making the manga *harvester runner* autonomous (it stays owner-attended per existing design; only the itinerary planner is autonomous).

---

## 2. Overall architecture

```
┌─ 1. Unified PWA shell ───────────────────────────────────────┐
│  one manifest · one service worker · dark theme · tab bar     │
│  🗺️ Trip    🖼️ Wall    🎴 Panels    ✨ Plan                    │
└───────────────────────────────────────────────────────────────┘
        │
   ┌────┴──── shared per-user TASTE MODEL (D1, keyed to device_id) ───┐
   │                                                                   │
┌─ 2. Harvester (phone + personal) ─┐        ┌─ 4. Planner (autonomous) ─┐
│ upload panels (photo pipeline)     │        │ scheduled Claude routine  │
│ tag likes + note → taste signal    │        │ → new stop ideas → Worker │
│ editable taste profile per user    │        │ Plan tab: approve/note    │
└────────────────────────────────────┘        └───────────┬───────────────┘
                                                           │ needs
                                              ┌─ 3. Web Push ─────────────┐
                                              │ VAPID · D1 subs · SW push │
                                              └───────────────────────────┘
(numbers = build order: Shell → Harvester → Push → Planner)
```

- **Frontend:** a multi-page app (MPA) served from GitHub Pages at `/Saturfun-Itinerary/`. Existing pages keep their own HTML; a shared **app shell** (tab bar + tokens) is injected into each. One service worker at the app root controls all of them.
- **Backend:** the existing Cloudflare Worker (`saturfun-worker`) gains routes + D1 tables for panels, taste, push subscriptions, and planner proposals. R2 stores panel + avatar + photo bytes. Workers AI stays for the free visitor chat only.
- **Autonomous brains:** run as **scheduled Claude Code routines** (the owner's subscription, not Workers AI and not the Anthropic pay-per-token API) — see §7 constraints.

---

## 3. Shared per-user taste model (cross-cutting)

Both the harvester and the planner read/write the same D1 shape, discriminated by `domain`:

```sql
-- The editable, user-facing profile (what the UI shows + lets you tune).
CREATE TABLE taste_profiles (
    device_id TEXT NOT NULL,
    domain    TEXT NOT NULL,          -- 'manga' | 'itinerary'
    data      TEXT NOT NULL,          -- JSON: weights, pins, focus, etc.
    updated   REAL NOT NULL,
    PRIMARY KEY (device_id, domain)
);
-- Raw feedback events the routines learn from (append-only).
CREATE TABLE taste_signals (
    id         TEXT PRIMARY KEY,
    device_id  TEXT NOT NULL,
    domain     TEXT NOT NULL,
    target_ref TEXT,                  -- panel id / proposal id / venue ref
    signal     TEXT NOT NULL,         -- JSON: {aspects:[...], note, verdict}
    created    REAL NOT NULL
);
CREATE INDEX idx_taste_signals ON taste_signals(device_id, domain, created);
```

- `taste_profiles.data` is **user-editable** (the "see + tune your taste" UI): aspect weights, pinned artists/series (manga) or neighborhoods/vibes (itinerary), current focus.
- `taste_signals` is the append-only log of tags/notes/verdicts a scheduled Claude run reads to refine the profile + generate better output.
- The owner's existing `data/manga-corpus/taste-profile.json` **seeds** the owner's `('<owner-device>', 'manga')` row on first migration.
- **Privacy:** taste + signals are keyed by `device_id` but `device_id` is **never returned to other clients** (the same rule the comment feature enforces — endpoints return only the requester's own taste or aggregate data).

---

## 4. Sub-project 1 — Unified PWA shell *(build first)*

**Goal:** one cohesive, installable dark app with a bottom tab bar across Trip / Wall / Panels / Plan.

**Approach — shared shell over existing pages (MPA), not a rewrite.**
- **`tokens.css`** — the single source of design tokens (ink `#0E0E10` / paper `#F2EFE9` / blood `#B33A3A` / gold `#D4AF37`, Playfair Display + Inter). Every page links it.
- **`app-shell.js` + `app-shell.css`** — injected into every page; renders the fixed **bottom tab bar**, marks the active tab, and can show a badge (e.g. pending proposals on **Plan**). Tabs: **Trip** → `index.html`, **Wall** → `wall.html`, **Panels** → the harvester hub (`manga.html`; the `panels.html` live viewer is linked from within it), **Plan** → new `plan.html`.
- **Re-theme `index.html` to dark** using `tokens.css` — the biggest single task; done carefully to preserve the itinerary's layout while moving off `#FAFAFA`.
- **One service worker `sw.js`** at the repo root (served at `/Saturfun-Itinerary/`, so its scope covers the whole app). Network-first with offline shell precache (the pattern already proven in `wall-sw.js`), plus the push handlers added in SP2. **Retires `wall-sw.js`** (scope widens from `wall` to the app root).
- **One manifest `saturfun.webmanifest`** — `name: "Saturfun"`, `start_url` the Trip tab, `display: standalone`, dark theme colors, app icons. Retires `wall.webmanifest`.
- Everything already live (reactions, comments, whirlwind, haptics) is untouched — it just gains the tab bar and the unified SW/manifest.

**Testing:** live-verify on the website + installed PWA that all four tabs load, the SW controls every page (not just wall), install works, and existing wall features still work. Bump the SW cache version on deploy.

---

## 5. Sub-project 2 — Harvester: phone-native + personalized *(build second)*

**Goal:** upload reference panels from your phone, tag what you like, and see + tune a per-user taste profile.

**Panel uploads — reuse the photo pipeline.**
- New route `POST /api/manga/panels` (multipart) reusing the existing magic-byte validation, R2 storage, and size caps from `/api/photos`. Bytes → R2 under a `panels/` prefix; metadata → a new `manga_panels` table (id, uploader `device_id`, `stored_name` R2 key never exposed, content_type, dims, source, created).
- `GET /api/manga/panels?device=` lists a user's reference panels; `GET /api/manga/panels/{id}/raw|thumb` serves bytes.
- These are the user's **personal reference panels** (taste-teaching), distinct from the owner-curated shared corpus (`data/manga-corpus/index.json`), which remains the discovery feed. The Panels hub shows both.

**Tag what you like — the feedback interaction.**
- Quick **aspect tags** from a fixed vocabulary (linework, composition, inking, shading, negative_space, dynamism, mood, expression, texture) + an optional **note**, per panel.
- Writes a `taste_signals` row (`domain='manga'`, `target_ref=panel id`, `signal={aspects, note}`), mirroring the reactions+comments pattern (fast taps + optional prose).

**Editable taste profile, per user.**
- A "your taste" view in the Panels tab reads `taste_profiles('<device>','manga')` and lets the user **tune it directly**: weight aspects ("inking > color"), pin favorite artists/series, set current focus. `GET`/`PUT /api/taste/manga` (device-scoped).
- Derived-but-steerable: a scheduled Claude run may propose updates from `taste_signals`, but the user's manual edits are authoritative.
- Migration seeds the owner's row from the existing `taste-profile.json`.

**Testing:** vitest for the store + routes (upload validation, tag signal, taste get/put, no `device_id` leak); UAT round-trip; live-verify upload + tag + edit-taste on a phone-sized viewport. Depends only on SP1 + existing photo/profile infra.

---

## 6. Sub-project 3 — Web Push *(build third)*

**Goal:** Saturfun can notify users even when the app is closed (prerequisite for the planner).

- **VAPID keypair** generated once. Public key shipped to the frontend (or served by the Worker); **private key + subject as Worker secrets** (`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`).
- **Frontend:** an "Enable notifications" control (in the Plan tab) → requests `Notification` permission → subscribes via `PushManager.subscribe({ applicationServerKey })` → `POST /api/push/subscribe` with the subscription. Stored in a new D1 `push_subscriptions` table (id, device_id, endpoint, p256dh, auth, created). `POST /api/push/unsubscribe` to remove.
- **Service worker** (`sw.js`, extended): a `push` event handler → `showNotification(title, body, { icon, data: { url } })`; a `notificationclick` handler → focus an existing client or `openWindow` to the target (the **Plan** tab).
- **Worker send path:** signs a VAPID request (ES256 JWT) and delivers to each subscription's push endpoint; **prunes dead subscriptions** on 404/410. Payload delivery approach (encrypted `aes128gcm` payload vs a data-less "tickle" that wakes the SW to fetch the latest) is chosen in the implementation plan — default to an encrypted payload for a self-contained, reliable notification.
- **iOS caveat (documented in-UI):** Web Push on iPhone requires the PWA to be **installed to the home screen** and iOS 16.4+. The enable-notifications flow guides "Add to Home Screen → Enable." Android/desktop work in-browser.

**Testing:** vitest for subscribe/unsubscribe + the send/prune logic (mock endpoints); live-verify permission → subscription stored → a test push arrives and click opens the Plan tab (Android/desktop; iOS verified by the owner on a real installed PWA).

---

## 7. Sub-project 4 — Autonomous itinerary planner *(build last)*

**Goal:** a scheduled Claude session generates new stop ideas grounded in your real data, learns from your feedback, and pushes you a batched digest when it has ideas to review.

**Brain — a scheduled Claude Code routine (owner subscription).**
- On a timer (a trigger/cron firing a Claude Code session — the environment is chosen at plan time via `list_environments`; see the dependency below), the routine reads: the `itinerary` taste profile + recent `taste_signals`, `data/venue-coords.json` + the current itinerary (for grounding + avoiding duplicates), and generates a few **creative new-stop ideas** (creative-first): each with a title, a one-line pitch, *why it fits*, a target neighborhood/track, and a `needs_verifying` flag when the place isn't in verified data.
- It `POST`s them to `POST /api/planner/proposals` (owner-authed with the owner token).

**Store + delivery (Worker + D1).**
- `proposals` table: id, created, title, pitch, fits_where, neighborhood, needs_verifying, `status` (pending/approved/rejected), place_ref, verified, note.
- On new proposals, the Worker sends **one batched push digest** ("✨ N new stop ideas to review") to the owner's subscriptions (via SP2). One ping per run, never per idea.

**Review + feedback (Plan tab).**
- Proposal cards: title · pitch · why-it-fits · a `needs verifying` badge. **Approve / Reject / + optional note.**
- Feedback updates `status` and appends a `taste_signals` row (`domain='itinerary'`); the next run reads it to refine.
- **Approve → verify:** geocode via the existing venue pipeline (`venue-coords.json` / Nominatim); once verified, the stop is eligible to drop into the real itinerary.

**The loop:** generate → push → you react → it learns → generates better — exactly "new ideas guided by user feedback," reaching you outside the app.

**Dependency (honest):** the routine runs in a **Claude Code environment that must be available when the timer fires** (the owner's machine kept on, or a persistent/cloud Claude environment). If offline at fire time, that run is skipped. Resolved at plan time by choosing the environment.

**Testing:** vitest for the proposals store + routes (create owner-authed, list pending, approve/reject → status + signal, digest-triggers-once) + no `device_id` leak; UAT; live-verify the Plan tab review flow + that approving triggers verification. The routine itself is validated by a dry-run generation reviewed before it's scheduled.

---

## 8. Constraints & cross-cutting rules

- **AI engine / billing:** the autonomous planner (and any Claude-driven harvester curation) use **Claude via the owner's subscription** (Claude Code / Agent SDK OAuth) — this is subscription quota, **not** the Anthropic pay-per-token API, and is the explicitly-allowed path. **Workers AI (Llama) stays only for the free visitor chat.** No pay-per-token Anthropic billing anywhere.
- **Identity & privacy:** anonymous `device_id` (+ optional name/avatar) as today; `device_id` is **never disclosed to other clients** (the comment-feature rule); taste/signals are per-device.
- **Uploads:** magic-byte validated (never trust Content-Type), size-capped, R2 stored under generated keys; the `stored_name` R2 key is never exposed.
- **D1:** all values are bound parameters; every new table is a **new migration** (`0006+`), never editing `0001`–`0005`.
- **Security:** all server-rendered user text is escaped; public write endpoints are rate-limited; owner-only actions gated by the owner token.
- **Both surfaces:** every change ships to the website **and** the installed PWA — one `sw.js` cache-version bump per deploy, pushed to `main` + `gh-pages`.

---

## 9. Build order & what each plan covers

1. **Shell** — `tokens.css`, `app-shell` (bottom tab bar), dark re-theme of `index.html`, unified `sw.js` + `saturfun.webmanifest`, retire `wall-sw.js`/`wall.webmanifest`. *Ships a cohesive installable app.*
2. **Harvester** — `manga_panels` + shared taste tables (migration), panel upload/list/serve routes (reusing the photo pipeline), tag→signal, per-user editable taste (`/api/taste/manga`), the Panels-tab UI. *Ships phone upload + tagging + editable taste.*
3. **Push** — VAPID keys, `push_subscriptions` table, subscribe/unsubscribe routes, SW push + notificationclick handlers, the Worker send/prune path, the enable-notifications UI. *Ships "Saturfun can notify you."*
4. **Planner** — `proposals` table (+ itinerary taste signals), the owner-authed proposals route, the batched-digest push, the scheduled Claude routine (environment chosen here), the Plan-tab review UI, verify-on-approve. *Ships the autonomous loop.*

Each sub-project is built subagent-driven (per-task spec+quality reviews + adversarial whole-branch review + prod UAT + live browser verification), exactly like the social layer.

---

## 10. Decisions log (from brainstorm)

- **Build order:** Shell → Harvester → Push → Planner. *(Shell first; Push before Planner since the planner notifies.)*
- **Navigation:** bottom tab bar (app-like).
- **Theme:** dark everywhere — re-theme the itinerary into ink/paper/blood/gold.
- **Proposal storage:** D1 (feedback is a write from a phone browser → needs a server store; D1 is the best-fit + already the proven pattern here; static gh-pages JSON can't accept browser writes).
- **Planner output:** new stops for the existing itinerary.
- **Grounding:** creative-first, verify-on-approval.
- **Planner engine:** Claude via subscription (scheduled Claude Code routine), highest quality — **not** Workers AI.
- **Notify cadence:** batched digest when a run finishes (one push per run).
- **Panel feedback:** quick aspect tags + optional note.
- **Personalization:** editable taste profile per user (see + tune), keyed to existing profiles.

## 11. Open items (resolved at plan time, not blocking)
- Planner's Claude environment (which env the timer fires into) — pick via `list_environments`.
- Push payload strategy (encrypted payload vs tickle-and-fetch) — default encrypted.
- Panels-tab primary page (`manga.html` hub vs a new `plan`-style harvester page) — hub, with `panels.html` linked inside.
- Web-push signing/encryption implementation (vetted approach in the plan).
