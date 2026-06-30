# Saturfun visitor-fallback Worker

A Cloudflare Worker that fronts CF Workers AI's
`@cf/meta/llama-3.3-70b-instruct-fp8-fast` model. It is the **visitor-mode chat
fallback** for the Saturfun static site: when a visitor's browser doesn't
support WebGPU (and therefore can't run the in-browser Qwen2.5 model), the
visitor.js bundle POSTs to this Worker instead.

**Free-tier only.** No paid Cloudflare resources. No Anthropic API. The hard
ceiling is Workers AI's free quota of **10,000 neurons / day**, which works
out to roughly 25–40 turns of this model per day across all visitors.

---

## Endpoint

`POST /api/chat`

**Request body** (`application/json`):

```json
{
  "messages": [
    { "role": "user", "content": "find me a vegetarian dinner spot in Williamsburg" }
  ],
  "context": [
    {
      "id": "venue-42",
      "name": "Champs Diner",
      "desc": "All-vegan diner in East Williamsburg.",
      "longDesc": "...",
      "vibe": ["casual", "late-night"],
      "dietary": ["vegan", "vegetarian"],
      "priceBand": "$$",
      "url": "https://champsdiner.com"
    }
  ]
}
```

`context` is the top-K corpus snippets the visitor's browser already retrieved
via CLIP / MiniLM. The Worker inlines them into the system prompt so the
model has the relevant facts. The Worker does **not** maintain its own corpus.

**Response:** Server-Sent Events stream — the **native** Workers AI SSE format,
passed straight through:

```
data: {"response":"Here are"}

data: {"response":" three spots"}

data: {"response":" in Williamsburg..."}

data: {"response":null,"usage":{"prompt_tokens":159,"completion_tokens":98,"total_tokens":257}}

data: [DONE]
```

Client recipe:

```js
const res = await fetch(`${WORKER_URL}/api/chat`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ messages, context }),
});
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buf.indexOf("\n\n")) >= 0) {
    const frame = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 2);
    if (!frame.startsWith("data:")) continue;
    const payload = frame.slice(5).trim();
    if (payload === "[DONE]") return;
    try {
      const obj = JSON.parse(payload);
      if (typeof obj.response === "string") appendDelta(obj.response);
    } catch { /* ignore */ }
  }
}
```

**Other endpoints:**

- `GET /healthz` → `200 ok` (no auth, useful for status badges).
- `OPTIONS /api/chat` → CORS preflight.

**Errors** (JSON):

| status | meaning                                         |
|-------:|-------------------------------------------------|
| 400    | bad / missing JSON body                         |
| 403    | `Origin` header not in `ALLOWED_ORIGINS`        |
| 405    | wrong method (only POST + OPTIONS allowed)      |
| 429    | per-IP rate limit exceeded (`Retry-After` set)  |
| 502    | upstream Workers AI invocation failed           |

---

## Photo wall (`/api/photos`)

A public image wall (transplanted from Artifact Studio): **anyone can upload + view;
DELETE is owner-gated.** Image bytes live in **R2** (`PHOTOS_BUCKET`), metadata in
**D1** (`DB`). Uploads are validated by **magic bytes only** — never Content-Type or
extension. See `src/photos.ts` (pure logic), `src/photo-store.ts` (R2+D1),
`src/photo-routes.ts` (routes).

| Method & path | Notes |
|---|---|
| `GET /api/photos` | `{photos:[…]}` newest first (no `stored_name`) |
| `POST /api/photos` | `multipart/form-data`, field **`files`**; partial batch → `200` with `{photos,errors}`; `400` not-image · `413` too-large · `507` store-full only when nothing succeeded |
| `GET /api/photos/{id}/raw` | original bytes, immutable cache |
| `GET /api/photos/{id}/thumb` | thumb (falls back to original — the edge has no Pillow) |
| `GET /api/photos/{id}/download` | original as an attachment |
| `DELETE /api/photos/{id}` | **owner only** — header `X-Owner-Token: <secret>`; fails closed if the secret is unset |

Caps (public endpoint hardening): `PHOTO_MAX_MB` (default 25) per file → `413`;
`PHOTO_MAX_TOTAL_GB` (default 3) total → `507`; `PHOTO_MAX_FILES_PER_REQUEST`
(default 20) → `413`; `PHOTO_MAX_REQUEST_MB` (default 100) body cap checked from
`Content-Length` *before* buffering → `413`. Per-file size is checked via `File.size`
before bytes are read (avoids isolate OOM); a failed D1 insert deletes its orphaned R2
object. Malformed `%`-encoded ids return `404` (not `500`).

> **Known limitation (low risk):** the total-store `507` guardrail is read-then-check
> per request (D1 `SUM(size)`), so many *concurrent* uploads racing right at the 3 GB
> boundary can overshoot it slightly. This is a disk-fill guardrail (R2 free tier is
> 10 GB), not a secrets boundary, and the per-request file/byte caps bound the overshoot.
> If you ever want it exact, replace the SUM check with an atomic reserve-then-commit on a
> single `store_meta(total_bytes)` row (`UPDATE … WHERE total_bytes + ? <= ?`, check
> `meta.changes === 1`) or a Durable Object holding the running total.

### One-time provisioning + deploy

```sh
cd worker
npx wrangler login

# R2 bucket + D1 database (paste the printed database_id into wrangler.toml)
npx wrangler r2 bucket create saturfun-photos
npx wrangler d1 create saturfun-db

# Owner secret that gates DELETE
npx wrangler secret put PHOTO_OWNER_TOKEN     # paste a long random string

# Apply the D1 schema (NOT auto-applied by deploy) — remote, then deploy
npx wrangler d1 migrations apply saturfun-db --remote
npx wrangler deploy
```

Local dev/UAT (R2/D1/KV all emulated locally — prod untouched):

```sh
npx wrangler d1 migrations apply saturfun-db --local   # seeds the local table
npx wrangler dev                                        # http://127.0.0.1:8787
```

Tests: `npm test` (watch) / `npm run test:run`. They use `wrangler.test.toml`
(omits the `[ai]` binding, which has no local emulator) and isolated R2/D1.

---

## Prerequisites

1. A Cloudflare account (free tier is enough).
2. Node.js 18+ locally.
3. `wrangler` CLI — installed automatically as a dev dep when you run `npm i`,
   or globally via `npm i -g wrangler`.

---

## Deploy (first time)

```sh
cd worker
npm install
npx wrangler login                        # opens browser, OAuth to your CF account

# Create the KV namespace for the rate limiter (production + preview).
npx wrangler kv namespace create RATE_LIMIT
npx wrangler kv namespace create RATE_LIMIT --preview
```

The two `kv namespace create` commands print something like:

```
Add the following to your wrangler.toml:
[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "abcd1234efgh5678ijkl9012mnop3456"
```

Paste those `id` and `preview_id` values into `wrangler.toml` (replacing the
two `REPLACE_WITH_*` placeholders), then deploy:

```sh
npx wrangler deploy
```

Expected output:

```
Total Upload: 23.41 KiB / gzip: 7.12 KiB
Worker Startup Time: 12 ms
Your Worker has access to the following bindings:
- AI:
  - Name: AI
- KV Namespaces:
  - RATE_LIMIT: abcd1234efgh5678ijkl9012mnop3456
- Vars:
  - RATE_LIMIT_MAX: "10"
  - RATE_WINDOW_SECONDS: "60"
  - MAX_TOKENS: "800"
  - ALLOWED_ORIGINS: "https://javendean.github.io,http://127.0.0.1:5173,http://localhost:5173"
Uploaded saturfun-worker (3.42 sec)
Deployed saturfun-worker triggers (1.18 sec)
  https://saturfun-worker.<your-subdomain>.workers.dev
```

Copy that URL — that's what the visitor.js fallback will POST to.

---

## Local development

```sh
npx wrangler dev          # binds 127.0.0.1:8787, runs in remote-bindings mode
                          # so you exercise real Workers AI calls (counts against
                          # your free quota — go sparingly).
```

Test from another terminal:

```sh
curl -N -X POST http://127.0.0.1:8787/api/chat \
  -H "Content-Type: application/json" \
  -H "Origin: http://127.0.0.1:5173" \
  -d '{
    "messages":[{"role":"user","content":"recommend a dinner spot"}],
    "context":[
      {"name":"Champs Diner","desc":"All-vegan diner in East Williamsburg.","vibe":["casual"],"dietary":["vegan"],"priceBand":"$$"}
    ]
  }'
```

You should see a stream of `data: {"response":"..."}` lines. The `-N`
(`--no-buffer`) flag is essential — without it curl will block until EOF.

Tail production logs:

```sh
npx wrangler tail
```

---

## Configuration

All knobs live in `wrangler.toml` under `[vars]`:

| var                   | default | meaning                                                    |
|-----------------------|--------:|------------------------------------------------------------|
| `RATE_LIMIT_MAX`      | `10`    | max requests per IP within the window                       |
| `RATE_WINDOW_SECONDS` | `60`    | sliding window size                                         |
| `MAX_TOKENS`          | `800`   | hard ceiling per response — caps worst-case neuron spend    |
| `ALLOWED_ORIGINS`     | (CSV)   | exact origin strings allowed via CORS + `Origin` check      |

`ALLOWED_ORIGINS` defaults to:
- `https://javendean.github.io` — production GitHub Pages site
- `http://127.0.0.1:5173` / `http://localhost:5173` — local `live-server`

Edit and re-deploy to add more origins.

---

## Free-tier neuron budget

Workers AI free tier: **10,000 neurons / day** (resets at UTC 00:00).

For `@cf/meta/llama-3.3-70b-instruct-fp8-fast`:
- Input:  26,668 neurons / 1M tokens (~$0.293 / M)
- Output: 204,805 neurons / 1M tokens (~$2.253 / M)

A typical Saturfun turn:
- ~600 input tokens (system prompt + context entries + brief history)
- ~150 output tokens (the prompt forces 2–4 short sentences)

Per-turn cost ≈ `0.0006 × 26,668 + 0.00015 × 204,805` ≈ **47 neurons**.

That puts the hard ceiling at roughly **200+ turns / day across all visitors**
in normal operation, dropping to ~30 turns/day in the worst case if every
response saturates the 800-token cap. Per-IP rate limits (10/min) keep any
single visitor from monopolising the quota.

When you exceed the daily quota, `env.AI.run` will throw and the Worker
returns `502 upstream model error` — the visitor.js fallback should display
a friendly "service is busy" banner and degrade gracefully.

---

## Troubleshooting

- **`KV namespace 'RATE_LIMIT' not bound`** — you forgot to paste the `id` /
  `preview_id` returned by `wrangler kv namespace create`. Re-run the create
  commands and edit `wrangler.toml`.
- **`502 upstream model error`** at deploy time — your account may not have
  Workers AI enabled. Visit the Cloudflare dashboard → Workers & Pages → AI
  and accept the terms of service once.
- **CORS blocked in browser console** — your site's origin isn't in
  `ALLOWED_ORIGINS`. Add it (no trailing slash) and redeploy.
- **`429 rate limit exceeded`** in normal use — bump `RATE_LIMIT_MAX` or
  shrink `RATE_WINDOW_SECONDS`. Note KV is eventually consistent across edge
  POPs (~60s), so the limit is approximate.
- **Streaming response shows up all at once** — your client (or its proxy) is
  buffering. `Accept: text/event-stream` on the request and `-N` for curl.
- **`wrangler dev` hits a real Workers AI billing meter** — yes, it does.
  Workers AI bindings always run remotely; there's no local emulator.

---

## Project layout

```
worker/
├── README.md           ← you are here
├── wrangler.toml       ← AI + KV bindings, vars, observability
├── package.json        ← scripts: dev, deploy, tail, typecheck, kv:create
├── tsconfig.json
├── .gitignore
└── src/
    ├── index.ts        ← request handler, CORS, validation, SSE pass-through
    ├── rate-limit.ts   ← KV-backed sliding-window limiter
    ├── system-prompt.ts← assembles the system prompt from the request context
    └── types.ts        ← TS interfaces (Env, ChatRequest, etc.)
```
