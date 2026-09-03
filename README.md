# Saturfun

A one-day Brooklyn itinerary site I built for a group of friends, plus the backend that grew
out of it. Live at <https://javendean.github.io/Saturfun-Itinerary/>.

It started as a scroll-driven itinerary page and turned into a small PWA with a shared photo
wall, a Cloudflare Worker API, and web push. The front end is plain HTML/CSS/JS with no build
step; the Worker is TypeScript with a real test suite.

## What is actually in here

### Scroll-driven front end (`index.html`)

One 4,400-line HTML file. GSAP 3.12.2 with ScrollTrigger drives the whole thing: a hero with
scattered floating photos that parallax and rotate on scroll, per-section reveals for each
itinerary stop, and a scrubbed "surprise" timeline that plays as you scroll through the last
section — the text falls away as a hidden panel rotates in. Tailwind is
loaded from the play CDN, so the styling is inline utility classes plus a long block of custom
CSS.

The itinerary data lives inline as a `itineraryData` array and is used twice: once to render
the scrolling stops, once to populate a Leaflet 1.9.4 + markercluster map. The map is lazily
constructed — `L.map()` is not called until the user expands the section — and joins the inline
data against `data/venue-coords.json` (67 geocoded venues). `tools/export-kml.mjs` dumps the
same venues to KML for Google Maps.

### Photo wall (`wall.html`, `wall.js`, ~1,100 lines)

A shared wall for the group. Drag-and-drop or file-picker upload, chunked into batches that
respect the Worker's per-request file and byte caps. Tiles open into a lightbox with emoji
reactions (a quick bar plus a free-text emoji input), threaded comments, display names, and
uploaded avatars downscaled client-side with a canvas before upload.

Saving back to a phone is the part that took the most work: it uses the Web Share API with
files, which requires a fresh user gesture per share, so multi-batch saves show a "share next"
button between batches and fall back to sequential downloads where sharing is unavailable.

It installs as a PWA (`saturfun.webmanifest`, `sw.js`). The service worker is network-first for
the app shell with a cache fallback, passes through everything cross-origin so `/api/*` is
never cached, and the page polls the deployed shell version to show a "new version — tap to
update" button when the SW cache tag changes.

### Cloudflare Worker (`worker/`)

TypeScript on Workers, using four bindings:

- **Workers AI** — `/api/chat` fronts `@cf/meta/llama-3.3-70b-instruct-fp8-fast` and passes the
  native SSE stream straight through rather than re-wrapping it.
- **KV** — per-IP sliding-window rate limiter (`src/rate-limit.ts`), with a separate, higher
  limit for uploads so a bulk photo dump does not eat the chat budget.
- **R2** — photo and avatar bytes.
- **D1** — all metadata. Eight migrations: photos, social, reactions, comments, avatars, manga
  panels, push subscriptions, planner proposals.

Upload hardening is the part worth reading (`src/photos.ts`, `src/photo-store.ts`,
`src/photo-routes.ts`): images are validated by **magic bytes only**, never by `Content-Type` or
file extension; per-file size is checked from `File.size` before any bytes are read, so a large
upload cannot OOM the isolate; request body size is checked from `Content-Length` before
buffering; a failed D1 insert deletes its orphaned R2 object. `DELETE` is gated by an
`X-Owner-Token` secret and fails closed when the secret is unset. `worker/README.md` documents
the endpoints, the error codes, and a known race in the total-storage guardrail.

`worker/test/` holds 187 test cases run with `@cloudflare/vitest-pool-workers` against local
R2/D1/KV, using a separate `wrangler.test.toml` that omits the AI binding (it has no local
emulator).

### Web push, without a library (`worker/src/web-push.ts`)

VAPID is implemented directly on WebCrypto: an ES256 JWT is signed with a P-256 private JWK
held as a Worker secret, and the raw `r||s` signature Web Crypto returns is already the JWS
format, so no ASN.1 conversion is needed. These are content-less "tickle" pushes — the service
worker wakes and fetches the actual digest — so there is no payload encryption path. Endpoints
that return 404 or 410 are pruned from D1 on the next send.

### Browser-side chat (`chat/`)

Two modes over the same bottom sheet. Visitor mode (`chat/visitor.js`) runs retrieval entirely
in the browser: a 1,139-entry venue corpus with int8-quantized MiniLM embeddings that are
dequantized to `Float32Array` on load, cosine top-K with an additive boost when the query names
a Brooklyn neighborhood, then Llama-3.2-3B streamed through WebLLM on WebGPU. If WebGPU is
absent it degrades to keyword-overlap ranking and the Worker's `/api/chat` endpoint. Owner mode
(`sidecar/sidecar.mjs`) bridges the page to a local `claude -p` subprocess over a
localhost-only WebSocket. `chat/VISITOR.md` and `sidecar/README.md` describe both.

## A note on the open photo API

`https://saturfun-worker.javendean.workers.dev/api/photos` has no authentication. `GET` returns
every photo and `POST` accepts uploads from anyone with the URL. That is deliberate: this is a
shared wall for one small group of friends, and asking them to make accounts to drop a photo
would have killed the thing. The tradeoff is bounded rather than ignored — magic-byte
validation, per-file and per-request size caps, a total-storage ceiling, per-IP rate limiting,
and owner-only deletes. It is a private-by-obscurity link, not an access control system, and it
should not be copied into anything that holds data that matters.

The friends whose photos appear in `images/friends/` have said they are fine with them being
public here.

## Running it

Static site — no build:

```sh
npm install
npm run serve          # live-server on :5173
```

Worker:

```sh
cd worker
npm install
npx wrangler dev       # :8787, local R2/D1/KV
npm run test:run       # vitest
```

Provisioning (R2 bucket, D1 database, secrets, migrations) is written out step by step in
`worker/README.md`.

The published site is served from the `gh-pages` branch; there is no CI, it is pushed by hand.

## Layout

```
index.html            itinerary page — GSAP, Leaflet, inline itinerary data
wall.html/.js/.css    photo wall
manga.html panels.html plan.html   other tabs of the same PWA
chat/                 bottom-sheet chat: visitor (browser RAG) + owner modes
sidecar/              local Node bridge to `claude -p` for owner mode
worker/               Cloudflare Worker: src/, migrations/, test/
tools/                node scripts: embed corpus, geocode, export KML, harvest
data/                 venue corpus, embeddings, coordinates, KML
docs/superpowers/     design docs written before the code
```

`docs/superpowers/` holds planning documents written ahead of the work, so they describe intent
rather than what shipped. The likes feature is the clearest example: there is a plan and a D1
`likes` table for it, but no code reads that table — emoji reactions replaced it. The source is
the accurate record.
