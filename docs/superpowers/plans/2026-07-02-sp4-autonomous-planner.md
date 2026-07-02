# SP4 — Autonomous Itinerary Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A scheduled Claude session generates creative new-stop ideas for the Brooklyn itinerary, stores them, and pushes the owner a batched digest; the owner reviews (approve/reject/note) in the Plan tab, and feedback refines the taste. Closes the loop: generate → notify → review → learn.

**Architecture:** The "brain" is a **Claude Code routine** (owner subscription — NOT Workers AI): it reads the `itinerary` taste + real venue data + the current itinerary and `POST`s proposals to the Worker (owner-authed). The Worker stores them in D1 (`proposals`, migration `0008`) and sends a push digest (reusing SP3's `sendToAll`). The Plan tab lists pending proposals for review; feedback writes a `taste_signals` row (domain `itinerary`) the next run reads. Verify-on-approve marks approved proposals eligible for the itinerary (auto-insertion into the hand-authored itinerary JSON is a documented follow-up).

**Tech Stack:** Cloudflare Worker (TS) · D1 · vitest-pool-workers · vanilla JS · a Claude routine (prompt) for generation.

## Global Constraints
- Generation uses the owner's **Claude subscription** (a scheduled Claude Code session), never the pay-per-token Anthropic API; Workers AI stays for the free visitor chat only.
- `POST /api/planner/proposals` is **owner-authed** (`isOwner` / `X-Owner-Token`) — only the owner's routine can create proposals. Feedback is device-scoped.
- D1: bound params; migration `0008` NEW. `device_id` never returned to clients. Escaping on render. Proposal text (title/pitch/why) is owner-generated (from the routine) but still escaped on render.
- New proposals trigger ONE batched push digest (reuse `sendToAll`); the digest endpoint reports the real pending count.
- Ships to website + PWA (bump `sw.js` `CACHE`, push main + gh-pages).
- Reuse: `jsonOk`/`detail`/`isOwner` (photo-routes.ts); `sendToAll` (web-push.ts); the shared `taste_signals`/`taste_profiles` (domain `itinerary`) + `getTaste`/`setTaste` from manga-store (or a shared move — keep importing from manga-store to avoid churn).

## File Structure
- Create `worker/migrations/0008_proposals.sql` — `proposals`.
- Create `worker/src/planner-store.ts` — proposal CRUD + feedback→signal + pending count.
- Create `worker/test/planner.spec.ts` — store + route tests.
- Modify `worker/src/photo-routes.ts` — `/api/planner/*` routes; update `GET /api/push/digest` to the real pending count.
- Modify `worker/src/index.ts` — route `/api/planner`.
- Modify `plan.html` — proposals review UI (+ Plan-tab badge via `saturfunSetPlanBadge`).
- Create `tools/planner-generate.md` — the routine prompt (the "brain") + the ready-to-enable schedule command.
- Modify `sw.js` — bump `CACHE`.

---

### Task 1: Migration 0008 + `planner-store.ts` (TDD)

**Files:** Create `worker/migrations/0008_proposals.sql`, `worker/src/planner-store.ts`, `worker/test/planner.spec.ts`.

**Interfaces:**
- `interface Proposal { id: string; title: string; pitch: string; fits_where: string; neighborhood: string; needs_verifying: number; status: string; created: number }`
- `createProposals(env, items: {title,pitch,fits_where,neighborhood,needs_verifying}[]): Promise<number>` (bulk insert, status 'pending', returns count)
- `listProposals(env, status?: string): Promise<Proposal[]>` (newest first; filter by status if given)
- `pendingCount(env): Promise<number>`
- `getProposal(env, id): Promise<Proposal | null>`
- `setFeedback(env, id, deviceId, verdict: 'approve'|'reject', note: string): Promise<void>` (sets status approved/rejected; appends a `taste_signals` row domain 'itinerary' target_ref=id signal={verdict,note})

- [ ] **Step 1: Migration** `0008_proposals.sql`:
```sql
CREATE TABLE IF NOT EXISTS proposals (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    pitch           TEXT NOT NULL,
    fits_where      TEXT NOT NULL DEFAULT '',
    neighborhood    TEXT NOT NULL DEFAULT '',
    needs_verifying INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'pending',
    created         REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, created DESC);
```
(`taste_signals`/`taste_profiles` already exist from migration 0006 — reuse.)

- [ ] **Step 2: Failing tests** — `createProposals` bulk-inserts pending + returns count; `listProposals()` newest-first, `listProposals('pending')` filters; `pendingCount`; `getProposal`; `setFeedback('approve')` → status 'approved' + a `taste_signals` row (domain 'itinerary', signal has verdict), `setFeedback('reject')` → 'rejected'. Use `env` from `cloudflare:test`.

- [ ] **Step 3: Run → fails.**

- [ ] **Step 4: Implement `planner-store.ts`** (bound SQL; `crypto.randomUUID().replace(/-/g,"")` ids; `Date.now()/1000`; setFeedback does an UPDATE proposals SET status + an INSERT taste_signals). Import nothing from manga-store for the signal (inline the taste_signals insert to keep the store self-contained, matching manga-store's tagPanel pattern).

- [ ] **Step 5: Run → passes** + `npx tsc --noEmit`.
- [ ] **Step 6: Commit** — `feat(planner): D1 proposals + store (create/list/feedback) (TDD)`.

---

### Task 2: Routes — `/api/planner/*` + real digest (TDD)

**Files:** Modify `worker/src/photo-routes.ts`, `worker/src/index.ts`; add tests to `worker/test/planner.spec.ts`.

**Interfaces:** `POST /api/planner/proposals` (owner-authed; body `{proposals:[{title,pitch,fits_where,neighborhood,needs_verifying}]}`) → validate + `createProposals` + `sendToAll(env)` (digest push) → `{created, pushed}`; `GET /api/planner/proposals?status=pending` → `{proposals:[...]}` (no device_id anywhere — proposals have none); `POST /api/planner/proposals/{id}/feedback` `{device_id, verdict, note}` → validate (verdict in approve|reject, device required) → `setFeedback` → `{ok:true}` (404 unknown id); update `GET /api/push/digest` → `{title:"Saturfun", body: pending>0 ? \`✨ ${pending} new stop idea(s) to review\` : "Open Saturfun to see what's new.", url:"plan.html"}`.

- [ ] **Step 1: Failing route tests** — POST proposals without owner → 403; with owner → stores + `{created:N}` (pushed count may be 0 with no subs); GET pending lists them; feedback approve → 200 + status flips (verify via GET or getProposal) + reject → rejected; feedback bad verdict/missing device → 400; unknown id → 404; `GET /api/push/digest` reflects the pending count.

- [ ] **Step 2: Run → fails.**

- [ ] **Step 3: Wire routes** in `photo-routes.ts` (`import * as planner from "./planner-store";` — `sendToAll` already imported): the `POST /api/planner/proposals` (isOwner gate; parse `{proposals}`; validate each has string title+pitch, cap lengths ~120/500; `createProposals`; then `let pushed=0; try{ pushed=(await sendToAll(env)).sent; }catch{}`; `jsonOk({created, pushed})`); `GET /api/planner/proposals` (status from `?status`, default 'pending'); `POST /api/planner/proposals/{id}/feedback` (regex `^/api/planner/proposals/([^/]+)/feedback$`; getProposal→404; validate; setFeedback). Update the existing `/api/push/digest` branch to compute `planner.pendingCount(env)`.

- [ ] **Step 4: `index.ts`** — add `|| url.pathname.startsWith("/api/planner")` to the guard.

- [ ] **Step 5: Run → passes** + `npx tsc --noEmit`.
- [ ] **Step 6: Commit** — `feat(planner): proposals routes (owner-post + digest push, list, feedback) + real digest (TDD)`.

---

### Task 3: Frontend — Plan-tab proposals review

**Files:** Modify `plan.html`.

- [ ] **Step 1:** On load, `GET /api/planner/proposals?status=pending`. If there are proposals, render a "New ideas" section ABOVE the notifications card: each proposal a `.proposal-card` with the title (serif), the pitch, a "why it fits" line, the neighborhood, a `needs verifying` gold badge when `needs_verifying`, and **Approve / Reject** buttons + an optional note input. Approve/Reject → `POST /api/planner/proposals/{id}/feedback {device_id, verdict, note}` → remove the card + toast. If none pending, keep the "planner is on its way / stay in the loop" framing. Escape all proposal text with `esc()`.
- [ ] **Step 2:** Badge the Plan tab: if `pending>0`, call `window.saturfunSetPlanBadge(true)` (exposed by app-shell.js) so the tab shows the dot. Clear it when the last pending is resolved.
- [ ] **Step 3:** Dark styling (shared tokens); reuse the card look. Keep the enable-notifications card (SP3) intact below.
- [ ] **Step 4: Verify** — grep plan.html for `/api/planner/proposals`, `feedback`, `saturfunSetPlanBadge`, `proposal-card`, `esc(`; confirm the notifications UI (SP3) is untouched; balanced braces. Live-verified in Task 4.
- [ ] **Step 5: Commit** — `feat(planner): Plan-tab proposals review (approve/reject/note) + tab badge`.

---

### Task 4: The routine (brain) + deploy + live loop verification (controller-run)

- [ ] **Step 1: Write `tools/planner-generate.md`** — the routine prompt: "Read `data/venue-coords.json` + the itinerary in `index.html` + `GET /api/taste/itinerary?device=<owner>` (recent taste). Generate 3 creative new-stop ideas (creative-first) that fit the Brooklyn/Industry-City driving itinerary and the owner's taste, each `{title, pitch, why-it-fits→fits_where, neighborhood, needs_verifying:1}`. Avoid duplicating existing stops. `POST` them as `{proposals:[...]}` to `https://saturfun-worker.javendean.workers.dev/api/planner/proposals` with header `X-Owner-Token: <token>`." Include the ready-to-enable **weekly schedule** command (a `create_trigger` cron `0 14 * * 6` = Sat, or a `claude -p` cron) with a clear note: **each run consumes subscription quota; enable when you want the autonomy.** Do NOT auto-create the trigger.
- [ ] **Step 2:** Apply migration 0008 remote; deploy the Worker; bump `sw.js` `CACHE`; push main + gh-pages.
- [ ] **Step 3: Live loop demo (controller = the brain, once):** the controller reads the taste/venues/itinerary and generates 3 real creative new-stop proposals, `POST`s them (owner token) → verify `{created:3}` + (if a sub exists) a digest push. Then on the Plan tab: the 3 proposals render with Approve/Reject; the Plan tab shows the badge; approve one + reject one + note → statuses flip (verify via GET) + `taste_signals` rows written; `GET /api/push/digest` shows "✨ N new stop ideas". Clean up the demo proposals afterward (or leave 1–2 real ones for the owner — owner's call; default: leave them as genuine first suggestions, they're real venues/ideas).
- [ ] **Step 4:** Prod UAT still green (light `/api/planner/proposals` GET 200 check). Confirm no `device_id` leak in planner responses.

## Self-Review
- **Coverage:** proposals table + store (T1); owner-post+digest+list+feedback routes + real digest (T2); Plan-tab review + badge (T3); routine prompt + deploy + live loop demo + opt-in schedule (T4). Owner-gated creation; subscription-not-API brain; feedback→taste_signals(itinerary) closing the loop; push digest reused from SP3.
- **Placeholders:** verify-on-approve = mark approved (auto-insert into the hand-authored itinerary JSON is a documented follow-up, not silently claimed). The schedule trigger is documented + opt-in (quota-respecting), not auto-created.
- **Type/name consistency:** `Proposal` + `createProposals`/`listProposals`/`pendingCount`/`getProposal`/`setFeedback` store→routes→UI; `taste_signals` domain 'itinerary'; digest reads `pendingCount`; `sendToAll` reused; frontend `saturfunSetPlanBadge` (from app-shell.js).
