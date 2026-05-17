# Panel Vault — Taste Calibration

The harvester (`tools/manga-harvest-runner.mjs`) is generic by default. It will
happily surface "popular shonen splash pages" all day unless it knows what the
reader actually values. This calibration layer fixes that.

## What it is

A ~25-panel guided walkthrough at:

> https://javendean.github.io/Saturfun-Itinerary/manga/calibrate.html

For each panel you answer four short questions:

1. **Excitement (1–5)** — how strongly the panel pulls you in.
2. **Pull-ins (multi-pick)** — composition, line quality, mood, character,
   action, perspective, screentone, lighting, negative space, detail density.
3. **Drawing orientation** — study material, both, or admire-only.
4. **Rarity (your eye)** — familiar / known-to-fans / rare gem.

The set spans four tiers on purpose:

| Tier              | What it probes                                          | Examples |
|-------------------|---------------------------------------------------------|----------|
| **Famous**        | Iconic, everyone-knows                                  | Berserk, Akira, Death Note, Naruto, Dragon Ball, AoT |
| **Well-known**    | Known to readers, not omnipresent (the target zone)     | Vagabond, Monster, Pluto, Vinland Saga, Punpun, Uzumaki |
| **Deep-cut**      | Rare panels from masters                                | Goodbye Eri (Fujimoto), Real (Inoue), Knights of Sidonia (Nihei), Domu (Otomo), Lone Wolf and Cub (Kojima), Land of the Lustrous (Ichikawa), Dorohedoro (Hayashida) |
| **Lesser-known**  | Artists worth knowing but not household names           | Blame!, Children of the Sea, Eden, Solanin |

Why covers? Manga covers concentrate the artist's visual signature — they're
the single most stable, public-domain-via-fair-use image surface available, and
they carry the same composition / mood / line-quality information needed to
distinguish taste axes. They also let the calibration ship instantly without
scraping interior pages. The harvester then takes the *bias* (not the literal
images) into its own discovery work.

## How the profile flows

```
  ┌───────────────────────────────┐
  │ /manga/calibrate.html         │  ← user rates ~25 panels
  │ saves → localStorage          │     (auto-save per click)
  └────────────┬──────────────────┘
               │ click "Download taste-profile.json"
               ▼
  ┌───────────────────────────────┐
  │ ~/Downloads/taste-profile.json│
  └────────────┬──────────────────┘
               │ user drops it
               ▼
  ┌───────────────────────────────┐
  │ data/manga-corpus/            │
  │   taste-profile.json          │  ← harvester reads at boot
  └────────────┬──────────────────┘
               │
               ▼
  ┌───────────────────────────────┐
  │ manga-harvest-runner.mjs      │
  │  • prepends preamble to every │
  │    discovery prompt           │
  │  • biases queue pop by        │
  │    tierEnthusiasm             │
  └───────────────────────────────┘
```

## Profile JSON shape

```jsonc
{
  "version": 1,
  "calibratedAt": "2026-05-17T20:00:00Z",
  "panelCount": 30,
  "ratingsByPanelId": {
    "berserk-vol1": {
      "excitement": 5,
      "pulledInBy": ["screentone", "mood/atmosphere", "line quality"],
      "drawing": "both",
      "rarity": "familiar",
      "completed": true,
      "lastUpdatedAt": "2026-05-17T20:01:30Z"
    },
    // … one entry per panel rated
  },
  "aggregates": {
    "ratedCount": 23,
    "tierEnthusiasm": {
      "famous": 3.4,
      "well-known": 4.2,
      "deep-cut": 4.6,
      "lesser-known": 3.8
    },
    "topTier": "deep-cut",
    "preferredPullIns": ["mood/atmosphere", "line quality", "screentone", "negative space", "perspective"],
    "topExcitedPanels": [
      { "id": "vagabond-vol1", "manga": "Vagabond", "artist": "Takehiko Inoue", "tier": "well-known", "excitement": 5 }
    ],
    "drawingOrientation": "drawing-focused",
    "rarityPreference": "leans rare"
  },
  "harvesterPromptInjection": "READER TASTE PROFILE (use as bias when picking panels to surface): • Strongest enthusiasm for: deep cuts from famous artists. • What pulls them in (in order): mood/atmosphere, line quality, screentone, negative space, perspective. • Rarity preference: leans rare. • Strongly drawing-focused — prioritize panels viable for a 10-minute pencil study. • Highest-excitement exemplars: Vagabond (Takehiko Inoue); Goodbye, Eri (Tatsuki Fujimoto); Real (Takehiko Inoue). Use this to bias which artists, tiers, and craft axes you surface. Avoid the \"popular shonen catalog\" trap unless the famous tier scored highest."
}
```

The `harvesterPromptInjection` field is the keystone — it's what gets prepended
to every discovery prompt the harvester sends. The aggregates also drive the
queue popping order.

## Quickstart

1. Open https://javendean.github.io/Saturfun-Itinerary/manga/calibrate.html
2. Rate ~25 panels (keyboard: `1`–`5` for excitement, `←`/`→` to navigate, `S` to skip).
3. On the summary screen, click **Download taste-profile.json**.
4. Move the downloaded file to `data/manga-corpus/taste-profile.json`.
5. Next time you run `node tools/manga-harvest-runner.mjs --loop`, it'll print:

   ```
   [manga-harvest] taste profile loaded (23 ratings, top tier=deep-cut)
   ```

That's it. Future runs will be biased toward your taste.

## Re-calibrating

Taste shifts. To reset:

- Open the calibration page.
- Hit the summary screen (skip through if needed), click **Restart calibration**.
- Or in DevTools: `localStorage.removeItem('saturfun.mangaTasteProfile.v1')`.

Then re-rate and re-export. The harvester will pick up the new profile on its
next boot.

## Notes on coverage

The current set leans heavily on **manga covers from Wikipedia** because they
are the single most stable, redistributable image surface available (fair-use
encyclopedic context). The trade-off is that covers are more polished than
interior panels — they're the artist's most-styled work, not their working
craft. We compensate by:

- Diversifying tiers (famous → lesser-known) so even within a single artist,
  the user sees their range.
- Including multi-work artists (Inoue: Slam Dunk + Vagabond + Real; Otomo:
  Akira + Domu; Urasawa: 20th Century Boys + Monster + Pluto; Asano: Punpun
  + Solanin; Nihei: Blame! + Knights of Sidonia) so cross-period comparisons
  emerge.
- Using `panelHint` text to call out what *kind* of moment the cover
  represents (style, composition, mood).

A v2 calibration could add interior panels from MangaDex via their `at-home`
CDN API, with verified per-chapter URLs. That's intentionally deferred —
covers are sufficient to identify taste signatures within the bandwidth a
~5-minute calibration allows.
