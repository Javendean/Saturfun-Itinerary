# Photo Wall — Social Layer (likes, comments, profiles) — Design Spec

**Date:** 2026-06-30
**Status:** Approved (design) — ready for implementation planning
**Feature:** Add Instagram-style likes + comments + lightweight profiles to the saturfun Photo Wall.

---

## 1. Overview & goals

Add to the existing public Photo Wall the ability to **like** photos and **comment** on them,
each attributed to a lightweight, no-login **profile** (display name + optional picture).

Built on the existing stack: a Cloudflare Worker (`saturfun-worker`) with **D1** (metadata) and
**R2** (image bytes), fronting a static frontend on GitHub Pages (`wall.html` / `wall.css` /
`wall.js`). No new infrastructure; no accounts/auth; no AI (so no API billing — consistent with
the project's hard constraint).

### Goals
- Like / unlike any photo (toggle), with a per-photo like count.
- Comment on any photo; see a thread of comments.
- A lightweight profile (display name + optional avatar) attached to your likes/comments.
- Live-ish: counts and threads reflect others' activity without a manual reload.

### Non-goals (YAGNI)
- Real accounts / login / passwords / OAuth.
- Notifications, mentions, hashtags, following, a global feed, DMs.
- Nested/threaded replies, comment editing, reactions beyond a single ❤.
- Profanity/AI moderation (owner manual moderation only).

---

## 2. Identity & profile model

No login. Identity is **per-device + anonymous**:

- On first visit, the client generates a UUID and stores it in `localStorage`
  (`saturfun_device_id`). This is the stable, anonymous identity for likes/comments.
- A **profile** is `{ device_id, name, avatar }`. Stored server-side in D1 (`profiles`), avatar
  bytes in R2. The profile is **optional**: without one you appear as "Someone".
- **Profile flow:** the first time you like or comment with no profile set, a small sheet prompts
  for a display name + optional picture. **Skippable** (stay "Someone"). A tiny avatar control in
  the header lets you set/change it anytime.
- Comments/likes store only `device_id`; name + avatar are **joined from `profiles` at read time**,
  so updating your name/pic updates it everywhere (including past comments). (Approach A — chosen
  over denormalized snapshots.)

**Trade-offs (accepted):** not tamper-proof — clearing storage loses identity / re-prompts; a user
can pick any name. Fine for a friends' wall; abuse is bounded by caps + owner moderation (§6).

---

## 3. Data model

### D1 (migration `0002_social.sql`)
```sql
CREATE TABLE IF NOT EXISTS profiles (
  device_id  TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  avatar_key TEXT,                       -- R2 key, or NULL (no picture)
  updated    REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS likes (
  photo_id   TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  created    REAL NOT NULL,
  PRIMARY KEY (photo_id, device_id)      -- exactly one like per device per photo
);
CREATE INDEX IF NOT EXISTS idx_likes_photo ON likes(photo_id);
CREATE TABLE IF NOT EXISTS comments (
  id         TEXT PRIMARY KEY,           -- uuid hex
  photo_id   TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  body       TEXT NOT NULL,
  created    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_photo ON comments(photo_id, created DESC);
```
**Cascade:** deleting a photo (existing owner-gated `DELETE /api/photos/{id}`) also deletes its
rows in `likes` + `comments` (and the like/comment counts disappear with it).

### R2
- Avatars under `avatars/{device_id}.{ext}`. Magic-byte validated (reuse `sniffImage`), per-file
  cap (~2 MB). The client **downscales to a ~256 px square JPEG** before upload, so stored avatars
  are a few KB — negligible R2 usage.

---

## 4. API contract (new Worker routes)

`device_id` is the anonymous localStorage id, sent in the JSON body (or `?device=` for GET list).
Error bodies use the existing `{ "detail": "..." }` shape. CORS as today.

| Method & path | Body | Returns |
|---|---|---|
| `GET /api/photos?device=X` | — | existing list **+ per-photo `like_count`, `comment_count`, `liked` (bool for device X)** |
| `POST /api/photos/{id}/like` | `{device_id}` | `{ "liked": bool, "count": n }` (toggles) |
| `GET /api/photos/{id}/comments` | — | `[{ id, body, created, name, avatar_url }]` **oldest-first** (Instagram-style) |
| `POST /api/photos/{id}/comments` | `{device_id, body}` | `201 { id, body, created, name, avatar_url }` · `400` empty/too-long · `429` rate-limited |
| `DELETE /api/photos/{id}/comments/{cid}` | — (header `X-Owner-Token` OR body/header `device_id`) | `{ok:true}` · `403` not owner & not author · `404` |
| `PUT /api/profile` | `{device_id, name}` + optional avatar (multipart `avatar`) | `{ name, avatar_url }` |
| `GET /api/profile/{device_id}` | — | `{ name, avatar_url }` or `404` |
| `GET /api/profile/{device_id}/avatar` | — | avatar bytes from R2 (immutable cache) or `404` |

Notes:
- `like_count`/`comment_count` via correlated subqueries (or `LEFT JOIN ... GROUP BY`) on the list
  query; `liked` via `LEFT JOIN likes ON device_id = ?`.
- `avatar_url` resolves to `GET /api/profile/{device_id}/avatar` (or null).
- 404 on unknown photo/comment, consistent with existing routes.

---

## 5. Frontend (lightbox + tiles + profile sheet)

- **Tiles:** a small, subtle badge in a corner — `❤ N · 💬 N`. Filled heart if this device liked it.
  Does not fight the gallery aesthetic.
- **Lightbox (existing):** below the image + filename —
  - a ❤ **like button** (filled when liked) + count → `POST .../like`;
  - a **comments thread**: scrollable list of `avatar · name · body · time`, plus an
    "Add a comment…" input + post button. Author's/owner's comments show a small delete affordance.
- **Profile sheet:** name input + optional picture (file → client downscale → preview) → save
  to localStorage + `PUT /api/profile`. Opened on first like/comment (skippable) and from a header
  avatar control. Stay "Someone" if skipped.
- All server-controlled text (names, comment bodies) is **escaped** on render (reuse `esc()`).

---

## 6. Abuse, moderation, security

Public, unauthenticated endpoints — same threat posture as uploads:
- **Comments:** body length cap (~500 chars); per-IP rate limit (own KV counter, like uploads);
  HTML-escaped on render (no XSS); empty/whitespace rejected.
- **Names:** length cap (~40), escaped.
- **Avatars:** magic-byte validated (`sniffImage`), size cap, client-downscaled; stored under a
  generated key; never trust Content-Type.
- **Likes:** deduped by composite PK; lightly rate-limited.
- **Moderation:** the **owner** (owner token) can delete **any** comment; an **author** can delete
  **their own** (device_id match). Photo deletion cascades.
- SQL: all values are **bound parameters** (no string concatenation), as in the existing routes.

---

## 7. Real-time / refresh

- Tile **counts** ride the existing **auto-refresh** (the 20 s `/api/photos?device=` poll already
  rebuilds the grid on change → badges update live; the change-signature must include
  like_count/comment_count so a count change triggers a re-render).
- The **open lightbox** fetches its comments on open + after you post; polls lightly (~15 s) while
  open so a friend's new comment/like appears. Stops polling when the lightbox closes.

---

## 8. Testing

Same discipline as the existing wall (TDD; vitest-pool-workers + ported UAT + browser verify):
- **Unit/integration (vitest):** like toggle + dedup + count; comment create/list/delete; profile
  upsert + avatar validation; owner-vs-author delete authorization (403/200); caps (400/413/429);
  `stored`/keys never leak; `GET ?device=` returns correct `liked`/counts; photo-delete cascade.
- **UAT (extend `photo_wall_uat.py`):** end-to-end like/comment/profile round-trips against
  `wrangler dev` and the deployed Worker; magic-byte avatar rejection; no-residue cleanup.
- **Browser:** lightbox like + comment + profile flows; tile badges; live update; owner/author
  delete; simulated-device tests as needed.

---

## 9. Build order (incremental, each a working ship)

1. **Schema + storage:** `0002_social.sql`; D1 methods + R2 avatar store (TDD).
2. **Likes:** routes + `?device=` list counts/liked; lightbox heart + tile ❤ badge; tests/UAT; deploy.
3. **Comments:** routes (create/list/delete + moderation); lightbox thread; 💬 badge; tests/UAT; deploy.
4. **Profiles:** profile routes + avatar upload/serve; profile sheet + header control; wire names/
   avatars into comments/likes; tests/UAT; deploy.
5. Bump the SW `CACHE` version on each frontend deploy (PWA update rule).

Each step deploys independently; the PWA auto-update (network-first + version prompt) carries the
new code to installed apps.

---

## 10. Open questions

- Comment ordering: oldest-first (Instagram) vs newest-first. **Default: oldest-first.**
- Exact caps (comment length, avatar size, rate limits): tune during implementation; start at
  500 chars / 2 MB / 30-per-min-per-IP.

(No blocking unknowns; identity, UI placement, profile flow, moderation, and storage are decided.)
