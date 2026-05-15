# Saturfun visitor mode (Mode B)

Static-page chat for site visitors who don't have the owner sidecar running. Lives entirely in the browser plus an optional Cloudflare Worker fallback. **Never touches the Anthropic API** — all heavy lifting is local.

## Activation

`chat/chat.js` opens a WebSocket to `ws://127.0.0.1:7331`. If the handshake doesn't complete inside 500 ms (typical for any page load that isn't on the owner's machine), it dynamic-imports `./visitor.js` and hands it the bottom-sheet DOM:

```js
mod.init({ append, appendBanner, body, textarea, sendBtn });
```

## Pipeline (lazy — fires on first user message)

```
user message
  └─> ensureBoot()                              // single-flight init
        ├─> fetch data/corpus/index.json        // cache: 'force-cache'
        ├─> fetch data/corpus/embeddings.json   // int8 quantized
        ├─> dequantize -> { id: Float32Array(384) }
        ├─> probe `navigator.gpu.requestAdapter()`
        │     ├─ ok  -> mode = 'webgpu'
        │     │         ├─> import('https://esm.run/@xenova/transformers@2.17.2')
        │     │         │     └─> pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
        │     │         └─> import('https://esm.run/@mlc-ai/web-llm')
        │     │               └─> CreateMLCEngine('Llama-3.2-3B-Instruct-q4f16_1-MLC')
        │     └─ no  -> mode = 'worker'
        └─> ready
  └─> retrieve()
        ├─ webgpu  -> embed(query) -> cosine top-K against embById
        └─ worker  -> keyword overlap rank as a degraded substitute
  └─> stream
        ├─ webgpu  -> engine.chat.completions.create({ stream: true })
        └─ worker  -> POST /api/chat (SSE)
  └─> if topScore < 0.4 -> show "Suggest research" button
```

## Browser support

| Path | Required | Notes |
| --- | --- | --- |
| **WebGPU (in-browser Llama-3.2-3B)** | Chrome 113+, Edge 113+, Safari 18+ desktop, ~3 GB free VRAM, ~2 GB disk for cached weights | First load downloads ~25 MB MiniLM + ~2 GB Llama. Cached after that. Mobile is gated by VRAM — practically desktop-only. |
| **Cloudflare Worker fallback** | Any modern browser | Hits `POST /api/chat` on the same origin. Worker is built by a separate agent; contract documented below. |

## Cloudflare Worker contract

The Worker is hand-rolled SSE — no Vercel AI SDK dependency on either side, to keep the free-tier budget honest.

```
POST /api/chat
Content-Type: application/json
Body: {
  messages: [{ role: 'system'|'user'|'assistant', content: string }, ...],
  context:  CorpusEntry[]   // already-retrieved top-K, ready to inline
}

Response: text/event-stream
  data: {"delta": "Hi there"}
  data: {"delta": "! Want some tacos"}
  data: {"delta": "?"}
  data: [DONE]

Errors: data: {"error": "rate limit hit"}  (then [DONE])
```

The Worker is responsible for picking its own backend (Workers AI's `@cf/meta/llama-3.1-8b-instruct`, a third-party gateway, etc.). The visitor module doesn't care, as long as the SSE shape matches.

## Project state safety

The visitor never persists. The only project-state verb it can touch is `enqueue_research`, gated by `chat/tools.js`'s `READ_ONLY` set:

```js
export const READ_ONLY = new Set(['enqueue_research']);
```

Even that is applied to a throwaway in-memory state object — the visitor synthesizes a topic and tells the user the owner will pick it up next harvest cycle. Nothing writes to `data/queue.json` from the browser.

## CDN sources

Pinned in `visitor.js` constant `CDN`:

- `https://esm.run/@xenova/transformers@2.17.2` (jsDelivr ESM gateway)
- `https://esm.run/@mlc-ai/web-llm`
- Fallbacks on `https://esm.sh/...` if `esm.run` fails

`@mlc-ai/web-llm` is **not** in `package.json` — it's CDN-only by policy. `@xenova/transformers` is in devDependencies for the Node-side `tools/embed-corpus.mjs` only; the browser pulls it from CDN.

## Open work

- The Cloudflare Worker (`/api/chat`) is being built by a parallel agent. Until it ships, non-WebGPU browsers will see a polite error.
- Pre-harvester corpus: when `data/corpus/index.json` 404s, the visitor degrades to a banner explaining the corpus isn't published yet rather than crashing.
