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
const TOP_K_ZONE = 8;                         // wider top-K when query names a specific zone
const ZONE_BOOST = 0.08;                      // additive bonus when entry zone matches query
const COSINE_FALLBACK_THRESHOLD = 0.4;        // below -> suggest research
const WORKER_FALLBACK_URL = 'https://saturfun-worker.javendean.workers.dev/api/chat';  // Cloudflare Worker (deployed 2026-05-16)
const VISITOR_CSS_HREF = 'chat/visitor.css';

// Zone slug -> phrases that should trigger zone-aware retrieval. Mirrored from
// tools/embed-corpus.mjs ZONE_PHRASES so retrieval and embedding agree on the
// canonical surface forms.
const ZONE_QUERY_PATTERNS = {
  'industry-city':   /\b(industry\s*city|industry-city|ic\b)/i,
  'sunset-park':     /\bsunset\s*park\b/i,
  'williamsburg':    /\bwilliamsburg\b/i,
  'park-slope':      /\bpark\s*slope\b/i,
  'carroll-gardens': /\bcarroll\s*gardens\b/i,
  'brooklyn-heights':/\bbrooklyn\s*heights\b/i,
  'gowanus':         /\bgowanus\b/i,
  'red-hook':        /\bred\s*hook\b/i,
  'fort-greene':     /\bfort\s*greene\b/i,
  'dumbo':           /\bdumbo\b/i,
  'bushwick':        /\bbushwick\b/i,
  'greenpoint':      /\bgreenpoint\b/i,
  'cobble-hill':     /\bcobble\s*hill\b/i,
  'prospect-heights':/\bprospect\s*heights\b/i,
  'crown-heights':   /\bcrown\s*heights\b/i,
  'flushing':        /\bflushing\b/i,
};

// CDN sources — pinned for reproducibility. esm.run is jsDelivr's ESM gateway;
// esm.sh is the documented fallback.
const CDN = {
  transformers: 'https://esm.run/@xenova/transformers@2.17.2',
  webllm:       'https://esm.run/@mlc-ai/web-llm',
  transformersAlt: 'https://esm.sh/@xenova/transformers@2.17.2',
  webllmAlt:       'https://esm.sh/@mlc-ai/web-llm',
};

const SYSTEM_PROMPT = `You are the Saturfun visitor concierge — a knowledgeable, friendly Brooklyn local helping someone plan a Saturday outing centered on Industry City.

Rules:
- Answer using ONLY the venue facts in CONTEXT (the retrieval block in this system message). CONTEXT is the corpus search result for the user's question — treat it as the canonical list of venues you may name.
- Never invent venues, addresses, hours, or prices. If you don't recognize a name from CONTEXT, do not say it.
- When the user asks about a neighborhood (e.g., "what's at Industry City"), name at least 3 specific venues from CONTEXT in your answer.
- If CONTEXT is empty or off-topic, say so briefly and suggest the user ask the owner to research more spots.
- Reply in 2-5 short sentences or a tight numbered list. Use venues' names and short descriptions verbatim from CONTEXT.`;

// ---------------------------------------------------------------------------
// Module-scoped state (per page load — visitor mode has no persistence)
// ---------------------------------------------------------------------------

let corpus = null;            // CorpusEntry[] from index.json
let embById = null;           // { [id]: Float32Array(384) } dequantized
let embedder = null;          // MiniLM pipeline (lazy)
let engine = null;            // WebLLM engine (lazy)
let mode = null;              // 'webgpu' | 'worker' | 'remote-owner' | 'unknown'
let bootPromise = null;       // single-flight init
let history = [];             // [{ role, content }] for multi-turn context
let dom = {};                 // { append, appendBanner, body, textarea, sendBtn, modeLabel? }
let remoteOwnerWs = null;     // active tunneled sidecar WS, or null
let remoteOwnerSection = null;// { root, statusEl, urlInput, passInput, connectBtn, forgetBtn, toggle }
let remoteAssistantStream = null; // streaming bubble for remote-owner mode

// localStorage keys for persistent remote-owner credentials
const LS_REMOTE_URL = 'saturfun.remoteOwner.tunnelUrl';
const LS_REMOTE_PASS = 'saturfun.remoteOwner.passphrase';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function init({ append, appendBanner, body, textarea, sendBtn, modeLabel }) {
  dom = { append, appendBanner, body, textarea, sendBtn, modeLabel };
  injectCss(VISITOR_CSS_HREF);

  // Owner-mode (remote) panel — sole-user-across-devices path. Renders before
  // the visitor banner so it's the first thing the owner sees on a friend's
  // phone. Visitors who don't know the passphrase ignore it.
  renderRemoteOwnerSection();

  appendBanner(
    'Visitor mode runs entirely in your browser — no signup, no tracking. ' +
    'Ask me anything about the Saturfun itinerary and I’ll search the venue corpus for you.'
  );

  sendBtn.addEventListener('click', send);
  textarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
  });

  // If the owner previously connected from this device, try to auto-restore the
  // remote-owner session. Failure is silent — falls back to webgpu/worker.
  tryAutoRestoreRemoteOwner();
}

async function send() {
  const text = dom.textarea.value.trim();
  if (!text) return;

  // Remote-owner mode: bypass the visitor RAG entirely. The tunneled sidecar
  // owns the whole conversation — same protocol the local owner mode uses.
  if (mode === 'remote-owner' && remoteOwnerWs && remoteOwnerWs.readyState === WebSocket.OPEN) {
    dom.append('user', text);
    dom.textarea.value = '';
    try {
      remoteOwnerWs.send(JSON.stringify({ type: 'prompt', text }));
    } catch (err) {
      dom.append('error', `Send failed: ${err?.message || err}`);
    }
    return;
  }

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

// Returns the zone slugs the query literally mentions (e.g., "what restaurants
// at Industry City" -> ["industry-city"]). Used to widen K and boost matching
// entries — zone-targeted queries want a survey, not the global top-5.
function detectZones(query) {
  const hits = [];
  for (const [slug, re] of Object.entries(ZONE_QUERY_PATTERNS)) {
    if (re.test(query)) hits.push(slug);
  }
  return hits;
}

async function retrieve(query) {
  if (!corpus?.length || !Object.keys(embById).length) return [];

  const zones = detectZones(query);
  const k = zones.length ? TOP_K_ZONE : TOP_K;

  let qvec;
  if (embedder) {
    const out = await embedder(query, { pooling: 'mean', normalize: true });
    qvec = out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
  } else {
    // Worker-fallback path: ask the Worker to embed too. For now, do a plain
    // keyword-overlap rank so we still send *something* useful as context.
    return keywordRank(query, corpus, k);
  }

  const scored = [];
  for (const entry of corpus) {
    const v = embById[entry.id];
    if (!v) continue;
    let score = cosine(qvec, v);
    // Tie-breaker / recall booster for zone-targeted queries. Cosine across
    // similar venues clusters tightly (often within 0.02), so even +0.08 reliably
    // floats same-zone matches above out-of-zone noise without overpowering
    // truly off-topic results.
    if (zones.length && zones.includes(entry.zone)) score += ZONE_BOOST;
    scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
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
// Remote-owner mode — tunneled sidecar via cloudflared, gated by a passphrase.
// ---------------------------------------------------------------------------
//
// Single-user-across-devices: the site owner runs sidecar.mjs locally with a
// SATURFUN_REMOTE_TOKEN env var, and a cloudflared tunnel exposes ws://127.0.0.1:7331
// at a public https URL. When the owner opens the site on any other device,
// they enter the URL+passphrase here and the chat routes through the tunnel
// to their local Claude Code subscription session.
//
// Anything visitors do never touches this code path — it's opt-in via the
// collapsible 🔓 panel. See sidecar/REMOTE-OWNER.md.

function renderRemoteOwnerSection() {
  // Build once, before the visitor banner. The panel itself stays collapsed
  // until the user taps the toggle pill.
  const root = document.createElement('div');
  root.className = 'sheet-remote-owner';
  root.dataset.role = 'remote-owner';     // visible to the ralph loop probe
  root.dataset.kind = 'remote-owner';     // legacy alias used by some queries

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'sheet-remote-toggle';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = '<span>🔓 Owner mode (remote)</span><span class="sheet-remote-chev">▾</span>';

  const panel = document.createElement('div');
  panel.className = 'sheet-remote-panel';
  panel.hidden = true;

  const urlLabel = document.createElement('label');
  urlLabel.className = 'sheet-remote-label';
  urlLabel.textContent = 'Tunnel URL';
  const urlInput = document.createElement('input');
  urlInput.type = 'url';
  urlInput.placeholder = 'https://abc-def-ghi.trycloudflare.com';
  urlInput.className = 'sheet-remote-input';
  urlInput.autocomplete = 'off';
  urlInput.spellcheck = false;
  urlInput.inputMode = 'url';

  const passLabel = document.createElement('label');
  passLabel.className = 'sheet-remote-label';
  passLabel.textContent = 'Passphrase';
  const passInput = document.createElement('input');
  passInput.type = 'password';
  passInput.placeholder = 'shared secret';
  passInput.className = 'sheet-remote-input';
  passInput.autocomplete = 'off';
  passInput.spellcheck = false;

  const btnRow = document.createElement('div');
  btnRow.className = 'sheet-remote-btnrow';
  const connectBtn = document.createElement('button');
  connectBtn.type = 'button';
  connectBtn.className = 'sheet-remote-connect';
  connectBtn.textContent = 'Connect';
  const forgetBtn = document.createElement('button');
  forgetBtn.type = 'button';
  forgetBtn.className = 'sheet-remote-forget';
  forgetBtn.textContent = 'Forget saved';
  btnRow.append(connectBtn, forgetBtn);

  const statusEl = document.createElement('div');
  statusEl.className = 'sheet-remote-status';
  statusEl.textContent = 'status: not connected';

  panel.append(urlLabel, urlInput, passLabel, passInput, btnRow, statusEl);
  root.append(toggle, panel);

  // Restore saved credentials (read-only — the user must still hit Connect
  // unless tryAutoRestoreRemoteOwner succeeds).
  try {
    const savedUrl = localStorage.getItem(LS_REMOTE_URL) || '';
    const savedPass = localStorage.getItem(LS_REMOTE_PASS) || '';
    if (savedUrl) urlInput.value = savedUrl;
    if (savedPass) passInput.value = savedPass;
  } catch { /* localStorage blocked — fine */ }

  toggle.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    const chev = toggle.querySelector('.sheet-remote-chev');
    if (chev) chev.textContent = open ? '▴' : '▾';
  });

  connectBtn.addEventListener('click', () => {
    const tunnelUrl = urlInput.value.trim();
    const passphrase = passInput.value;
    if (!tunnelUrl || !passphrase) {
      setRemoteStatus('status: enter both tunnel URL and passphrase', 'warn');
      return;
    }
    connectRemoteOwner(tunnelUrl, passphrase, { persist: true, fromUser: true });
  });

  forgetBtn.addEventListener('click', () => {
    try {
      localStorage.removeItem(LS_REMOTE_URL);
      localStorage.removeItem(LS_REMOTE_PASS);
    } catch {}
    urlInput.value = '';
    passInput.value = '';
    disconnectRemoteOwner('user requested forget');
    setRemoteStatus('status: forgotten — saved credentials cleared', 'ok');
  });

  remoteOwnerSection = { root, toggle, panel, urlInput, passInput, connectBtn, forgetBtn, statusEl };

  // Mount at top of body, before the visitor banner.
  dom.body.appendChild(root);
}

function setRemoteStatus(text, tone = 'info') {
  if (!remoteOwnerSection?.statusEl) return;
  remoteOwnerSection.statusEl.textContent = text;
  remoteOwnerSection.statusEl.dataset.tone = tone;
}

// Convert a Cloudflare https tunnel URL into the wss WebSocket URL.
function tunnelToWs(tunnelUrl, token) {
  let u;
  try { u = new URL(tunnelUrl); } catch { throw new Error('invalid tunnel URL'); }
  if (u.protocol === 'https:') u.protocol = 'wss:';
  else if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol !== 'wss:' && u.protocol !== 'ws:') {
    throw new Error(`unsupported protocol: ${u.protocol}`);
  }
  // Strip trailing slash on pathname (cloudflared base URL has none anyway).
  if (u.pathname === '/') u.pathname = '';
  u.searchParams.set('token', token);
  return u.toString();
}

function connectRemoteOwner(tunnelUrl, passphrase, { persist, fromUser } = {}) {
  setRemoteStatus('status: connecting…', 'info');
  let wsUrl;
  try { wsUrl = tunnelToWs(tunnelUrl, passphrase); }
  catch (err) {
    setRemoteStatus(`status: ${err.message}`, 'error');
    return;
  }

  // Tear down any existing remote socket before opening a new one.
  if (remoteOwnerWs) {
    try { remoteOwnerWs.close(); } catch {}
    remoteOwnerWs = null;
  }

  let ws;
  try { ws = new WebSocket(wsUrl); }
  catch (err) {
    setRemoteStatus(`status: connect failed — ${err?.message || err}`, 'error');
    return;
  }

  // 8s timeout for the tunnel handshake. trycloudflare quick tunnels usually
  // open in <1s; if we're past 8s the URL is wrong or the sidecar is down.
  const openTimer = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      setRemoteStatus('status: timed out — check tunnel URL and that sidecar is running', 'error');
      try { ws.close(); } catch {}
    }
  }, 8000);

  ws.addEventListener('open', () => {
    clearTimeout(openTimer);
    remoteOwnerWs = ws;
    mode = 'remote-owner';
    if (dom.modeLabel) dom.modeLabel.textContent = 'Owner mode (remote)';
    setRemoteStatus('status: connected · Owner mode (remote) · Disconnect', 'ok');
    // Swap button labels: connect → disconnect
    remoteOwnerSection.connectBtn.textContent = 'Disconnect';
    if (persist) {
      try {
        localStorage.setItem(LS_REMOTE_URL, tunnelUrl);
        localStorage.setItem(LS_REMOTE_PASS, passphrase);
      } catch {}
    }
    // Collapse the panel after a successful manual connect so the chat is the
    // primary surface again. Auto-restore stays expanded only if the user opens it.
    if (fromUser && !remoteOwnerSection.panel.hidden) {
      remoteOwnerSection.panel.hidden = true;
      remoteOwnerSection.toggle.setAttribute('aria-expanded', 'false');
      const chev = remoteOwnerSection.toggle.querySelector('.sheet-remote-chev');
      if (chev) chev.textContent = '▾';
    }
    if (fromUser) {
      dom.appendBanner('Connected to local Claude via tunnel. Streaming responses through the sidecar.');
    }
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'hello') return;            // greet handled by status
    if (msg.type === 'turn_start') { remoteAssistantStream = null; dom.sendBtn.disabled = true; return; }
    if (msg.type === 'turn_end') { dom.sendBtn.disabled = false; remoteAssistantStream = null; return; }
    if (msg.type === 'error') { dom.append('error', msg.message); return; }
    if (msg.type !== 'event' || !msg.event) return;

    const e = msg.event;
    if (e.type === 'assistant' && e.message?.content) {
      for (const c of e.message.content) {
        if (c.type === 'text' && c.text) {
          if (!remoteAssistantStream) remoteAssistantStream = dom.append('assistant', '');
          remoteAssistantStream.textContent += c.text;
          dom.body.scrollTop = dom.body.scrollHeight;
        } else if (c.type === 'tool_use') {
          dom.append('tool', `→ ${c.name}(${JSON.stringify(c.input).slice(0, 200)})`);
        }
      }
    } else if (e.type === 'result' && typeof e.result === 'string') {
      dom.append('assistant', e.result);
    } else if (e.type === 'stream_event' && e.event?.delta?.text) {
      if (!remoteAssistantStream) remoteAssistantStream = dom.append('assistant', '');
      remoteAssistantStream.textContent += e.event.delta.text;
      dom.body.scrollTop = dom.body.scrollHeight;
    }
  });

  ws.addEventListener('close', (ev) => {
    clearTimeout(openTimer);
    if (ws !== remoteOwnerWs && remoteOwnerWs !== null) return; // stale socket
    remoteOwnerWs = null;
    remoteAssistantStream = null;
    dom.sendBtn.disabled = false;
    if (mode === 'remote-owner') {
      mode = null;
      if (dom.modeLabel) dom.modeLabel.textContent = 'Visitor mode';
    }
    if (remoteOwnerSection) remoteOwnerSection.connectBtn.textContent = 'Connect';
    // 4001 = our sidecar's auth-rejected close code
    if (ev.code === 4001) {
      setRemoteStatus('status: rejected — wrong passphrase', 'error');
    } else if (ev.code === 1006) {
      setRemoteStatus('status: disconnected — could not reach tunnel (URL wrong or sidecar offline)', 'error');
    } else {
      setRemoteStatus(`status: disconnected (code ${ev.code}${ev.reason ? ' — ' + ev.reason : ''})`, 'warn');
    }
  });

  ws.addEventListener('error', () => {
    // Detailed reason comes through onclose. Just note that something went wrong.
    clearTimeout(openTimer);
    setRemoteStatus('status: connection error — see browser console', 'error');
  });
}

function disconnectRemoteOwner(reason) {
  if (remoteOwnerWs) {
    try { remoteOwnerWs.close(1000, reason || 'client disconnect'); } catch {}
    remoteOwnerWs = null;
  }
  remoteAssistantStream = null;
  if (mode === 'remote-owner') {
    mode = null;
    if (dom.modeLabel) dom.modeLabel.textContent = 'Visitor mode';
  }
  if (remoteOwnerSection) remoteOwnerSection.connectBtn.textContent = 'Connect';
}

function tryAutoRestoreRemoteOwner() {
  let savedUrl = null, savedPass = null;
  try {
    savedUrl = localStorage.getItem(LS_REMOTE_URL);
    savedPass = localStorage.getItem(LS_REMOTE_PASS);
  } catch { return; }
  if (!savedUrl || !savedPass) return;
  // Silent restore — no banner spam if the owner's machine is off. The status
  // panel inside the collapsible reflects the outcome.
  connectRemoteOwner(savedUrl, savedPass, { persist: false, fromUser: false });
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
