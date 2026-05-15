// Visitor-mode entry (Mode B) — Phase 4 in-browser RAG.
//
// Pipeline on first user message:
//   1. lazy-fetch data/corpus/{index,embeddings}.json (corpus may be empty pre-harvest)
//   2. dequantize int8 vectors -> Float32Array (matches tools/embed-corpus.mjs format)
//   3. detect WebGPU; if absent -> Cloudflare Worker fallback path
//   4. lazy-import @xenova/transformers (MiniLM) for query embedding
//   5. cosine top-K retrieval, then build a context-stuffed system prompt
//   6. lazy-import @mlc-ai/web-llm (Llama-3.2-3B), stream tokens into a single bubble
//   7. low-confidence answer -> offer a 'Suggest research' affordance
//      (calls verbs.enqueue_research locally; visitor cannot persist, so it's a hint
//       to the user that an owner should pick this up.)
//
// Hard rule: visitor never mutates project state on disk. All verbs are filtered
// through chat/tools.js's READ_ONLY set (currently just enqueue_research).

import { verbs, READ_ONLY } from './tools.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CORPUS_URL = 'data/corpus/index.json';
const EMBEDDINGS_URL = 'data/corpus/embeddings.json';
const TEXT_EMBED_MODEL = 'Xenova/all-MiniLM-L6-v2';
const LLM_MODEL = 'Llama-3.2-3B-Instruct-q4f16_1-MLC';
const TOP_K = 5;
const COSINE_FALLBACK_THRESHOLD = 0.4;        // below -> suggest research
const WORKER_FALLBACK_URL = '/api/chat';      // Cloudflare Worker (separate agent)
const VISITOR_CSS_HREF = 'chat/visitor.css';

// CDN sources — pinned for reproducibility. esm.run is jsDelivr's ESM gateway;
// esm.sh is the documented fallback.
const CDN = {
  transformers: 'https://esm.run/@xenova/transformers@2.17.2',
  webllm:       'https://esm.run/@mlc-ai/web-llm',
  transformersAlt: 'https://esm.sh/@xenova/transformers@2.17.2',
  webllmAlt:       'https://esm.sh/@mlc-ai/web-llm',
};

const SYSTEM_PROMPT = `You are the Saturfun visitor concierge — a knowledgeable, friendly Brooklyn local helping someone plan a Saturday outing centered on Industry City. Always ground answers in the venue context provided. If the context is thin or empty, say so honestly and suggest the user ask the owner to research more spots. Keep answers under ~120 words unless asked for detail. Use the venues' names and short descriptions; never invent addresses, hours, or prices.`;

// ---------------------------------------------------------------------------
// Module-scoped state (per page load — visitor mode has no persistence)
// ---------------------------------------------------------------------------

let corpus = null;            // CorpusEntry[] from index.json
let embById = null;           // { [id]: Float32Array(384) } dequantized
let embedder = null;          // MiniLM pipeline (lazy)
let engine = null;            // WebLLM engine (lazy)
let mode = null;              // 'webgpu' | 'worker' | 'unknown'
let bootPromise = null;       // single-flight init
let history = [];             // [{ role, content }] for multi-turn context
let dom = {};                 // { append, appendBanner, body, textarea, sendBtn }

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function init({ append, appendBanner, body, textarea, sendBtn }) {
  dom = { append, appendBanner, body, textarea, sendBtn };
  injectCss(VISITOR_CSS_HREF);

  appendBanner(
    'Visitor mode runs entirely in your browser — no signup, no tracking. ' +
    'Ask me anything about the Saturfun itinerary and I’ll search the venue corpus for you.'
  );

  sendBtn.addEventListener('click', send);
  textarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
  });
}

async function send() {
  const text = dom.textarea.value.trim();
  if (!text) return;
  dom.append('user', text);
  dom.textarea.value = '';
  dom.sendBtn.disabled = true;
  history.push({ role: 'user', content: text });

  try {
    await ensureBoot();
    const hits = await retrieve(text);
    const ctx = hits.map((h) => h.entry);
    const lowConfidence = hits.length === 0 || hits[0].score < COSINE_FALLBACK_THRESHOLD;

    if (mode === 'webgpu') {
      await streamWebLLM(text, ctx);
    } else {
      await streamWorker(text, ctx);
    }

    if (lowConfidence) offerResearch(text);
  } catch (err) {
    console.error('[visitor] send failed:', err);
    dom.append('error', `Something went wrong: ${err?.message || err}`);
  } finally {
    dom.sendBtn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Boot — fetch corpus, pick mode, warm up the heavy stack on demand
// ---------------------------------------------------------------------------

function ensureBoot() {
  if (!bootPromise) bootPromise = boot();
  return bootPromise;
}

async function boot() {
  const warming = appendStatus('Warming up the in-browser brain…');
  try {
    await loadCorpus();

    // WebGPU detection. We probe both the API surface and (lazily) requestAdapter
    // so older browsers exposing only `navigator.gpu` without an adapter degrade.
    const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;
    let adapter = null;
    if (hasGpu) {
      try { adapter = await navigator.gpu.requestAdapter(); } catch { adapter = null; }
    }
    mode = adapter ? 'webgpu' : 'worker';

    if (mode === 'webgpu') {
      warming.textContent =
        'First-time setup: downloading MiniLM (~25 MB) + Llama-3.2-3B (~2 GB). ' +
        'This is cached after the first load.';
      await loadEmbedder(warming);
      await loadEngine(warming);
      warming.textContent = `Ready. Running locally on your GPU. Corpus: ${corpus.length} venues.`;
    } else {
      warming.textContent =
        `WebGPU not available — falling back to the Saturfun Worker. Corpus: ${corpus.length} venues.`;
    }
  } catch (err) {
    warming.textContent = `Setup failed: ${err?.message || err}`;
    warming.dataset.kind = 'error';
    bootPromise = null; // allow retry on next message
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Corpus + embeddings: fetch, parse, dequantize
// ---------------------------------------------------------------------------

async function loadCorpus() {
  // The corpus may legitimately not exist yet (pre-harvester run). Be graceful.
  const [idxRes, embRes] = await Promise.allSettled([
    fetch(CORPUS_URL, { cache: 'force-cache' }),
    fetch(EMBEDDINGS_URL, { cache: 'force-cache' }),
  ]);

  if (idxRes.status !== 'fulfilled' || !idxRes.value.ok) {
    corpus = [];
    embById = {};
    dom.appendBanner('Venue corpus not published yet — answers will be generic until the owner runs the harvester.');
    return;
  }
  corpus = await idxRes.value.json();

  if (embRes.status !== 'fulfilled' || !embRes.value.ok) {
    embById = {};
    return;
  }
  const file = await embRes.value.json();
  embById = {};
  for (const [id, payload] of Object.entries(file.vectors || {})) {
    embById[id] = dequantize(payload, file.dim || 384);
  }
}

// Inverse of tools/embed-corpus.mjs#quantize: vec[i] = q[i] * scale.
function dequantize({ s, q }, dim) {
  const out = new Float32Array(dim);
  for (let i = 0; i < dim && i < q.length; i++) out[i] = q[i] * s;
  return out;
}

// ---------------------------------------------------------------------------
// Lazy heavy imports
// ---------------------------------------------------------------------------

async function loadEmbedder(statusEl) {
  const mod = await dynamicImport(CDN.transformers, CDN.transformersAlt);
  // Keep the env quiet in browser — onnxruntime-web emits a lot otherwise.
  if (mod.env) {
    mod.env.allowLocalModels = false;
    mod.env.useBrowserCache = true;
  }
  embedder = await mod.pipeline('feature-extraction', TEXT_EMBED_MODEL, {
    progress_callback: (p) => {
      if (p?.status === 'progress' && p.file && typeof p.progress === 'number') {
        statusEl.textContent = `Embedder: ${p.file} ${Math.round(p.progress)}%`;
      }
    },
  });
}

async function loadEngine(statusEl) {
  const mod = await dynamicImport(CDN.webllm, CDN.webllmAlt);
  engine = await mod.CreateMLCEngine(LLM_MODEL, {
    initProgressCallback: (p) => {
      // p.text is human-readable; p.progress is 0..1 for the current shard
      const pct = typeof p.progress === 'number' ? ` ${Math.round(p.progress * 100)}%` : '';
      statusEl.textContent = `Llama-3.2-3B:${pct} ${p.text || ''}`.trim();
    },
  });
}

async function dynamicImport(primary, fallback) {
  try { return await import(/* @vite-ignore */ primary); }
  catch (err) {
    console.warn('[visitor] primary CDN failed, trying fallback:', err);
    return await import(/* @vite-ignore */ fallback);
  }
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

async function retrieve(query) {
  if (!corpus?.length || !Object.keys(embById).length) return [];

  let qvec;
  if (embedder) {
    const out = await embedder(query, { pooling: 'mean', normalize: true });
    qvec = out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
  } else {
    // Worker-fallback path: ask the Worker to embed too. For now, do a plain
    // keyword-overlap rank so we still send *something* useful as context.
    return keywordRank(query, corpus, TOP_K);
  }

  const scored = [];
  for (const entry of corpus) {
    const v = embById[entry.id];
    if (!v) continue;
    scored.push({ entry, score: cosine(qvec, v) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, TOP_K);
}

function cosine(a, b) {
  // Both vectors are unit-normalized in MiniLM mean-pool mode -> dot product == cosine.
  // Guard against rare scale rounding by computing the full thing.
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const x = a[i], y = b[i]; dot += x * y; na += x * x; nb += y * y; }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

function keywordRank(query, entries, k) {
  const tokens = new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  if (!tokens.size) return [];
  return entries
    .map((entry) => {
      const hay = `${entry.name} ${entry.desc || ''} ${entry.longDesc || ''}`.toLowerCase();
      let score = 0;
      tokens.forEach((t) => { if (hay.includes(t)) score++; });
      return { entry, score: score / tokens.size };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ---------------------------------------------------------------------------
// Generation — WebGPU path (in-browser Llama)
// ---------------------------------------------------------------------------

async function streamWebLLM(userText, ctxEntries) {
  const messages = buildMessages(userText, ctxEntries);
  const bubble = dom.append('assistant', '');
  let acc = '';

  // WebLLM uses an OpenAI-compatible chat.completions.create with stream:true.
  const stream = await engine.chat.completions.create({
    messages,
    stream: true,
    temperature: 0.6,
    max_tokens: 512,
  });

  for await (const chunk of stream) {
    const delta = chunk?.choices?.[0]?.delta?.content || '';
    if (!delta) continue;
    acc += delta;
    bubble.textContent = acc;
    dom.body.scrollTop = dom.body.scrollHeight;
  }
  history.push({ role: 'assistant', content: acc });
}

// ---------------------------------------------------------------------------
// Generation — Cloudflare Worker fallback path
// ---------------------------------------------------------------------------
//
// Worker contract (matches the actual implementation in worker/src/index.ts):
//   POST {WORKER_FALLBACK_URL}
//   body: { messages: [{role, content}], context: CorpusEntry[] }
//   response: text/event-stream using the native Workers AI shape:
//     `data: {"response":"<token chunk>"}\n\n`   — repeated per delta
//     `data: {"response":null,"usage":{...}}\n\n` — final frame, response is null
//     `data: [DONE]\n\n`                           — terminator
//   Errors (defensive — the Worker may also emit these): `data: {"error":"..."}`.
//
// We pass the native binding shape through rather than re-wrapping it; saves a
// translation layer on the Worker side.

async function streamWorker(userText, ctxEntries) {
  const bubble = dom.append('assistant', '');
  let acc = '';

  const messages = buildMessages(userText, ctxEntries);
  let res;
  try {
    res = await fetch(WORKER_FALLBACK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({ messages, context: ctxEntries }),
    });
  } catch (err) {
    bubble.textContent =
      'Couldn’t reach the Saturfun Worker, and your browser doesn’t support local inference. ' +
      'Try a recent Chrome or Edge desktop build for the in-browser experience.';
    return;
  }
  if (!res.ok || !res.body) {
    bubble.textContent = `Worker returned ${res.status}. Try again in a moment.`;
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by \n\n. Each line starts with 'data: '.
    let nl;
    while ((nl = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const obj = JSON.parse(payload);
          if (obj.error) { bubble.textContent = `Worker error: ${obj.error}`; return; }
          if (typeof obj.response === 'string') { acc += obj.response; bubble.textContent = acc; dom.body.scrollTop = dom.body.scrollHeight; }
        } catch { /* ignore malformed frames */ }
      }
    }
  }
  history.push({ role: 'assistant', content: acc });
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildMessages(userText, ctxEntries) {
  const ctxBlock = ctxEntries.length
    ? ctxEntries.map(formatEntry).join('\n---\n')
    : '(no matching venues in corpus)';
  // Inline the retrieved context into the system message so it shows up first
  // in the model's attention window. Llama-3.2-3B handles ~8k context cleanly.
  const system = `${SYSTEM_PROMPT}\n\nVenue context (top ${ctxEntries.length} matches):\n${ctxBlock}`;
  // Cap multi-turn history at the last 6 turns to stay well under the context window.
  const tail = history.slice(-6);
  const turns = tail.length ? tail : [{ role: 'user', content: userText }];
  return [{ role: 'system', content: system }, ...turns];
}

function formatEntry(e) {
  const tags = [
    e.zone && `zone: ${e.zone}`,
    e.priceBand && `price: ${e.priceBand}`,
    e.duration && `duration: ${e.duration}`,
    e.vibe?.length && `vibe: ${e.vibe.join(', ')}`,
    e.dietary?.length && `dietary: ${e.dietary.join(', ')}`,
  ].filter(Boolean).join(' · ');
  return [
    `Name: ${e.name}`,
    e.desc && `Desc: ${e.desc}`,
    e.longDesc && `Notes: ${e.longDesc}`,
    tags && `Tags: ${tags}`,
    e.url && `URL: ${e.url}`,
  ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------
// Suggest-research affordance
// ---------------------------------------------------------------------------
//
// When retrieval is weak we offer a button that synthesizes a research topic
// the owner can run later. The visitor cannot persist to data/queue.json (it's
// browser-side and read-only), so we apply the verb to a throwaway in-memory
// state and surface the synthesized topic as confirmation.

function offerResearch(query) {
  if (!READ_ONLY.has('enqueue_research')) return; // safety
  const wrap = document.createElement('div');
  wrap.className = 'sheet-suggest';
  const label = document.createElement('span');
  label.textContent = 'Want me to ask the Saturfun owner to research this?';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sheet-suggest-btn';
  btn.textContent = 'Suggest research';
  btn.addEventListener('click', () => {
    const topic = query.length > 140 ? query.slice(0, 140) + '…' : query;
    try {
      verbs.enqueue_research.apply({ queue: [] }, {
        topic,
        reason: 'visitor low-confidence query',
        requestedBy: 'user',
      });
      btn.disabled = true;
      btn.textContent = 'Suggested';
      label.textContent = 'Sent. The next time the owner runs the harvester it’ll pick this up.';
    } catch (err) {
      label.textContent = `Couldn’t queue: ${err?.message || err}`;
    }
  });
  wrap.append(label, btn);
  dom.body.appendChild(wrap);
  dom.body.scrollTop = dom.body.scrollHeight;
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function appendStatus(text) {
  const el = document.createElement('div');
  el.className = 'sheet-banner sheet-status';
  el.textContent = text;
  dom.body.appendChild(el);
  dom.body.scrollTop = dom.body.scrollHeight;
  return el;
}

function injectCss(href) {
  if (document.querySelector(`link[data-visitor-css="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.visitorCss = href;
  document.head.appendChild(link);
}
