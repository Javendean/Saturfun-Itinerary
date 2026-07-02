# Saturfun Autonomous Planner — the generation routine ("brain")

The planner's brain is a **Claude Code session on the owner's subscription** (NOT Workers AI,
NOT the pay-per-token API). It reads the owner's taste + real venue data + the current
itinerary, generates a few creative new-stop ideas, and POSTs them to the Worker, which stores
them and pushes the owner a digest. The owner reviews (approve/reject/note) in the Plan tab.

## Run it manually (one cycle)

Run this as a Claude Code prompt (`claude -p "..."`) from the repo root, or paste into a session:

```
Generate 3 creative new-stop ideas for the Saturfun Brooklyn itinerary and POST them to the planner.

1. Read `data/venue-coords.json` (real geocoded venues) and the itinerary data in `index.html`
   (the `itineraryData` + `tracks` arrays) to understand the current stops, neighborhoods, and vibe.
2. Read the owner's evolving taste: GET https://saturfun-worker.javendean.workers.dev/api/taste/itinerary?device=<OWNER_DEVICE_ID>
   and the recent feedback it implies (approved vs rejected proposals shape future ideas).
3. Generate exactly 3 NEW stop ideas (creative-first) that fit a car-based Industry-City-anchored
   Brooklyn day (Red Hook / Williamsburg / Park Slope / Dumbo / Bed-Stuy clusters), do NOT duplicate
   existing stops, and lean into the owner's taste. Each idea:
   { "title": "<the place / activity>", "pitch": "<one vivid sentence on why it's worth it>",
     "fits_where": "<which part of the day / near which anchor it slots>",
     "neighborhood": "<cluster>", "needs_verifying": 1 }
   (needs_verifying stays 1 — these are creative-first; the owner verifies on approve.)
4. POST them:
   curl -X POST https://saturfun-worker.javendean.workers.dev/api/planner/proposals \
     -H "Content-Type: application/json" -H "X-Owner-Token: <OWNER_TOKEN>" \
     -d '{"proposals":[ ...the 3 objects... ]}'
   A 200 with {"created":3,"pushed":N} means stored + a digest push fired to N subscriptions.
```

Replace `<OWNER_DEVICE_ID>` (your localStorage `saturfun_device_id`) and `<OWNER_TOKEN>`
(the PHOTO_OWNER_TOKEN secret, in your password manager).

## Make it autonomous (opt-in — each run spends subscription quota)

The planner is autonomous when this runs on a schedule. **This is left OFF by default** so it
never surprises your quota. To enable a weekly Saturday-morning run, create a scheduled trigger
(fires a fresh Claude session that runs the prompt above), e.g. via the Claude Code Remote
`create_trigger` tool with `cron_expression: "0 14 * * 6"` (Sat 14:00 UTC ≈ 10am ET) and
`create_new_session_on_fire: true`, prompt = the generation prompt above. Or a plain OS cron:

```
0 10 * * 6  cd /path/to/Saturfun && claude -p "$(cat tools/planner-generate.md | sed -n '/^Generate 3/,/the 3 objects/p')"
```

Delete the trigger anytime to pause the autonomy. The manual command above always works on demand.
