# Whole-Itinerary Generation — Design Spec

**Date:** 2026-07-02
**Status:** Approved (design) — pending user review before implementation planning
**Extends:** the SP4 autonomous planner (which generates individual *stops*) to generate **entire itineraries** — the deferred "itineraries later" half of the original social/planner vision.

---

## 1. Overview & goals

The planner today generates individual new *stops* for the existing hand-crafted itinerary. This adds generation of **entire itineraries** — full timed day-plans *and* lighter themed routes — created two ways (autonomous + on-demand), reviewed in the Plan tab, and kept in a switchable library in the Trip tab alongside the original.

### Goals
- Generate whole itineraries at **flexible grain**: a full timed day-plan ("plan my Saturday") or a themed mini-route ("a rainy-day Dumbo loop").
- **Two triggers:** autonomous (the Claude routine dreams them up) and on-demand (a prompt box gives an instant draft, upgradeable by Claude).
- **Grounded** in real venues (`data/venue-coords.json` + approved stop-proposals + the existing itinerary's places) so stops are real and drive segments are computable.
- **Plan = review inbox** (preview → Save/Dismiss/Perfect-this); **Trip = library** (a switcher over the original + saved generated itineraries).
- Feedback (save/dismiss) feeds the shared `itinerary` taste, so future generations improve.

### Non-goals (YAGNI)
- Deep drag-reorder editing of a generated itinerary (v1 = Save/Dismiss whole + swap-a-stop; deeper editing is a follow-up).
- Auto-inserting generated itineraries into the hand-authored `index.html` (they live as their own rendered plans).
- Real-time multi-user collaboration on an itinerary.
- Anthropic pay-per-token API (Claude paths use the owner **subscription**; instant drafts use **Workers AI**).

---

## 2. Decisions log (from brainstorm)

- **Triggers:** BOTH autonomous (Claude routine) + on-demand.
- **Grain:** flexible — full timed day-plans AND themed mini-routes.
- **Surfacing:** Plan = review inbox (Save/Dismiss); Trip = switchable library alongside the original.
- **On-demand engine:** instant Workers-AI draft + an async "✨ Have Claude perfect this" (Claude routine, Opus).
- **Grounding:** assembled from real venues; AI composes arc/timing/flow; un-verified picks flagged `needs verifying`.
- **v1 editability:** Save/Dismiss whole + swap-a-stop; deeper editing deferred.

---

## 3. Data model (D1, migration `0009_itineraries.sql`)

```sql
CREATE TABLE IF NOT EXISTS itineraries (
    id        TEXT PRIMARY KEY,
    title     TEXT NOT NULL,
    summary   TEXT NOT NULL DEFAULT '',
    grain     TEXT NOT NULL DEFAULT 'day',      -- 'day' | 'route'
    source    TEXT NOT NULL DEFAULT 'auto',     -- 'auto' | 'draft' | 'polished'
    status    TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'saved' | 'dismissed' | 'polish_requested'
    body      TEXT NOT NULL,                    -- JSON (see below)
    device_id TEXT,                             -- who requested a draft (owner for auto); NEVER returned
    created   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_itineraries_status ON itineraries(status, created DESC);
```
Reuses `taste_signals` / `taste_profiles` (domain `itinerary`, from migration 0006).

**`body` JSON shape** (the renderer reads this):
```json
{
  "stops": [
    { "time": "1:00 PM", "title": "Steve's Key Lime Pie", "pitch": "...", "neighborhood": "Red Hook", "place_ref": "steves-...", "needs_verifying": 0 }
  ],
  "drives": [ { "from": 0, "to": 1, "drive_min": 12 } ]
}
```
- `stops[]`: ordered; `time` optional (present for `day` grain, omitted for loose `route`); `place_ref` = a `venue-coords` key or null; `needs_verifying` per stop.
- `drives[]`: segments between consecutive stops (indices into `stops`); `drive_min` optional.

---

## 4. Generation paths

### (a) Autonomous — Claude routine (owner subscription)
`tools/planner-generate.md` gains an itinerary mode: occasionally the scheduled Claude run composes ONE whole itinerary (day or route) from the taste + real venues + the existing itinerary → `POST /api/itineraries` (owner-authed) → `status='pending'`, `source='auto'` → digest push ("✨ a new itinerary to review").

### (b) On-demand instant draft — Workers AI (free tier)
A prompt box in Plan → `POST /api/itineraries/draft {prompt, grain?}` → the Worker builds a grounding context from `venue-coords.json` (a compact list of real venues + neighborhoods) + the prompt, calls **Workers AI (Llama)** asking for a grounded itinerary JSON in the `body` shape, validates/repairs the JSON, stores it (`status='pending'`, `source='draft'`, `device_id`), and returns it immediately. Rate-limited (own KV counter) to protect the free tier.

### (c) Claude polish — async upgrade
A "✨ Have Claude perfect this" button on a draft → `POST /api/itineraries/{id}/polish` sets `status='polish_requested'`. The next Claude routine run reads `GET /api/itineraries?status=polish_requested`, regenerates that itinerary at Opus quality (same body shape, real venues), `PUT`s it back (`source='polished'`, `status='pending'`), and pushes "your polished itinerary is ready."

---

## 5. API routes

`device_id` is never returned in any response. Error bodies use the existing `{detail}` shape. CORS as today.

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `POST /api/itineraries` | POST | **owner** | Claude routine stores a generated itinerary → `{id}` + digest push |
| `POST /api/itineraries/draft` | POST | rate-limited | Instant Workers-AI grounded draft → returns the itinerary JSON |
| `POST /api/itineraries/{id}/polish` | POST | (open) | Flag `polish_requested` (404 if unknown) |
| `PUT /api/itineraries/{id}` | PUT | **owner** | Routine writes the polished body back |
| `POST /api/itineraries/{id}/save` | POST | **owner** | → `status='saved'`; write a positive `taste_signals(itinerary)` |
| `POST /api/itineraries/{id}/dismiss` | POST | **owner** | → `status='dismissed'`; negative `taste_signals` |
| `GET /api/itineraries?status=pending` | GET | public | Plan review inbox (no device_id) |
| `GET /api/itineraries?status=saved` | GET | public | Trip library (no device_id) |
| `GET /api/itineraries/{id}` | GET | public | One itinerary (for rendering) |

`index.ts` routes `/api/itineraries` to `handlePhotoRoute`. The digest (`GET /api/push/digest`, from SP3/SP4) is extended to count pending *itineraries* too ("✨ N new ideas + an itinerary to review" — keep the message simple).

---

## 6. Frontend

### Plan tab — review inbox (extends the SP4 proposals UI)
- A **"New itineraries"** section (pending, `source` auto/draft/polished): each a preview card — title · summary · grain badge (`day`/`route`) · the stop list (via the shared renderer, compact) → **Save / Dismiss** (owner) and, for a `draft`, **✨ Perfect this**.
- An **on-demand generator**: a prompt input + grain hint + "Generate" → calls `/draft` → the new draft appears in the section. A small "generating…" state.
- The Plan-tab badge (`saturfunSetPlanBadge`) reflects pending stops + itineraries.

### Trip tab — itinerary library
- An **itinerary switcher** (a select/segmented control or a shelf) at the top: **"The Original"** (the current hand-crafted itinerary, unchanged) + each **saved** generated itinerary (`GET ?status=saved`).
- Selecting the original shows today's page as-is; selecting a generated one renders it via the shared renderer in the same dark layout. A deep-link (`#itin=<id>`) is nice-to-have.

### Shared flexible renderer
- A single module that renders a `body` (stops + drives) into the dark itinerary layout — timed checkpoints for `day`, a loose ordered list for `route`, drive segments between, `needs verifying` badges, Google-directions links per stop (reuse the existing pattern). Used by the Trip library AND the Plan preview (compact mode). Escapes all AI-generated text.

### v1 editability
- Preview → **Save / Dismiss** whole. **Swap-a-stop**: on a stop, a "swap" control offers a few alternative real venues (from `venue-coords`, same neighborhood) → replaces that stop in the `body` (owner, `PUT`). Deeper reorder/edit = follow-up.

---

## 7. Constraints & cross-cutting rules

- **AI engines:** autonomous + polish = Claude via the owner **subscription** (Claude Code routine). Instant drafts = **Workers AI (Llama)** on the free tier. **No pay-per-token Anthropic API.**
- **Grounding:** compose from real `venue-coords` venues + approved stop-proposals + existing itinerary places; flag any un-verified stop `needs_verifying`. The instant-draft prompt is given the real venue list so Llama can't invent addresses (and its output JSON is validated/repaired server-side; bad stops dropped).
- **Auth:** owner-gated writes for `POST /api/itineraries`, `PUT`, `save`, `dismiss` (owner curates the public library, like the panel vault / photo delete). `/draft` is rate-limited (own KV prefix, e.g. `rli`). `device_id` never disclosed.
- **Security:** all AI text escaped on render (it's model output); D1 bound params; migration `0009` NEW (never edit 0001–0008).
- **Both surfaces:** ships to website + PWA (bump `sw.js` `CACHE`, push main + gh-pages).
- **Reuse:** `sendToAll` (digest push), `isOwner`/`jsonOk`/`detail`, `checkRateLimit`, the `taste_signals` model, the `venue-coords` data.

---

## 8. Build order (phased — each ships + is verified)

1. **Core loop (data + autonomous + review + renderer).** `itineraries` table (0009); owner `POST` + `GET ?status=` + `save`/`dismiss` routes; the shared flexible renderer; the Plan "New itineraries" review section; the Claude routine composing whole itineraries (demonstrated once live, like SP4). *Ships: autonomous itineraries → review → save.*
2. **Trip library.** The itinerary switcher in the Trip tab (Original + saved), rendering saved itineraries.
3. **On-demand draft.** The Plan prompt box + `POST /api/itineraries/draft` (Workers-AI grounded draft).
4. **Claude polish.** `polish` request/flag + `PUT` write-back + the routine picking up `polish_requested` + the "ready" push.

Each phase is built subagent-driven (implement + review + fix), deployed, and live-verified — same rhythm as SP1–SP4.

---

## 9. Testing
- **vitest:** the itineraries store (create/list-by-status/save/dismiss→taste_signal/get/put); the routes (owner gates → 403, draft validation/repair + rate-limit, save/dismiss status flips, no device_id leak, digest counts itineraries); the draft JSON validator/repair (drops invalid stops, enforces the body shape).
- **UAT:** an itinerary round-trip (owner POST → GET pending → save → GET saved → dismiss).
- **Live (chrome-devtools):** Plan review cards render via the shared renderer; on-demand prompt → a grounded draft appears; save → it shows in the Trip switcher + renders; owner-gate + rate-limit behavior. Autonomous + polish demonstrated by a controller-run generation cycle (Claude = the brain).

## 10. Open items (resolved at plan time, not blocking)
- Exact Workers-AI prompt + JSON-repair strictness for the instant draft (tune during build).
- Drive-time source for `drive_min` (compute from `venue-coords` lat/lng as a rough estimate, or leave optional/blank v1).
- The Trip switcher control style (select vs shelf) — a visual call at build time.
- Digest wording when both stops + itineraries are pending (keep it simple).
