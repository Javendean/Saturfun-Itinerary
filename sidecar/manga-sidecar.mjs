// Manga sidecar — bridges the /manga.html bottom-sheet chat to a Claude Agent
// SDK session running Claude Opus 4.7 (1M context) with vision over OAuth
// (subscription-billed). Separate from sidecar/sidecar.mjs (port 7331) so the
// itinerary chat and the manga chat don't share session state.
//
// Critical: ANTHROPIC_API_KEY is stripped from the SDK call's env; OAuth wins
// only when the API key is absent. The user must run `claude setup-token`
// once to populate CLAUDE_CODE_OAUTH_TOKEN in their shell env.
//
// Usage:
//   export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...   # one-time, persisted
//   unset ANTHROPIC_API_KEY                            # if previously set
//   node sidecar/manga-sidecar.mjs

import { WebSocketServer } from 'ws';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 7332;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'claude-opus-4-7[1m]'; // bracket-suffix selects the 1M-context variant
const ALLOWED_TOOLS = ['Read', 'WebSearch', 'WebFetch'];
// Owner-only — file edits should go through the harvester, not the chat session.
// Add 'Edit' here if interactive corpus tweaks become a habit.

if (process.env.ANTHROPIC_API_KEY) {
  console.warn('[manga-sidecar] WARNING: ANTHROPIC_API_KEY is set in the parent env.');
  console.warn('[manga-sidecar] It will be stripped per-call so OAuth subscription billing wins.');
}
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.warn('[manga-sidecar] WARNING: CLAUDE_CODE_OAUTH_TOKEN not set.');
  console.warn('[manga-sidecar] Run `claude setup-token` first or the SDK will fail to authenticate.');
}

// Lazy-import the SDK so that if it's missing we can fall back gracefully on
// connect rather than crashing the whole server.
let querySdk = null;
async function loadSdk() {
  if (querySdk !== null) return querySdk;
  try {
    const mod = await import('@anthropic-ai/claude-agent-sdk');
    querySdk = mod.query;
  } catch (err) {
    querySdk = false;
    console.error('[manga-sidecar] FATAL: @anthropic-ai/claude-agent-sdk not installed.');
    console.error('[manga-sidecar] Run: npm install @anthropic-ai/claude-agent-sdk');
    console.error('[manga-sidecar] error:', err.message);
  }
  return querySdk;
}

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });
console.log(`[manga-sidecar] listening on ws://127.0.0.1:${PORT}  cwd=${REPO_ROOT}`);
console.log(`[manga-sidecar] model=${MODEL}  allowedTools=${ALLOWED_TOOLS.join(',')}`);

wss.on('connection', (ws) => {
  let pending = null;             // deferred resolver for the next prompt
  let inFlight = false;           // serialize turns per-connection
  let messageQueue = [];          // SDK consumes via async generator
  let querySession = null;        // active SDK iteration (kept open for follow-ups)

  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

  send({ type: 'hello', repo: REPO_ROOT, model: MODEL });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== 'prompt' || typeof msg.text !== 'string') return;

    if (inFlight) {
      send({ type: 'error', message: 'previous turn still running' });
      return;
    }

    const sdkQuery = await loadSdk();
    if (!sdkQuery) {
      send({ type: 'error', message: 'agent SDK not installed; run `npm install @anthropic-ai/claude-agent-sdk`' });
      return;
    }

    inFlight = true;
    send({ type: 'turn_start' });

    try {
      // Resolve any image references in the prompt of the form `image:./path/to.png`
      // (relative to repo root). Owner-typed in-line attachment hint — keeps the
      // wire format simple for the static page.
      const { text, images } = await extractImageRefs(msg.text);
      const content = [{ type: 'text', text }];
      for (const img of images) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.b64 },
        });
      }

      // Streaming-input async generator — required by the SDK whenever the
      // user message contains image content blocks. The plain `query({prompt:string})`
      // helper does not accept structured content arrays.
      async function* userMessages() {
        yield {
          type: 'user',
          message: { role: 'user', content },
        };
      }

      // Strip ANTHROPIC_API_KEY for THIS call so OAuth wins. We mutate
      // process.env briefly because the SDK reads it at call-time; restore after.
      const savedKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      try {
        for await (const event of sdkQuery({
          prompt: userMessages(),
          options: {
            model: MODEL,
            allowedTools: ALLOWED_TOOLS,
            cwd: REPO_ROOT,
            maxTurns: 6,
          },
        })) {
          // Forward every SDK event into the same envelope the saturfun
          // sidecar uses, so chat/sheet-core.js's wire handler works as-is.
          send({ type: 'event', event });
        }
      } finally {
        if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
      }

      send({ type: 'turn_end' });
    } catch (err) {
      console.error('[manga-sidecar] turn error:', err);
      send({ type: 'error', message: String(err?.message || err) });
      send({ type: 'turn_end' });
    } finally {
      inFlight = false;
    }
  });

  ws.on('close', () => {
    inFlight = false;
    pending = null;
    messageQueue = [];
  });
});

// Parse `image:<path>` tokens out of the prompt and base64-load them.
// Bounded to repo-root-relative paths to avoid arbitrary disk read from chat.
async function extractImageRefs(prompt) {
  const pattern = /image:([^\s]+)/g;
  const refs = [];
  const stripped = prompt.replace(pattern, (_, p) => { refs.push(p); return ''; }).trim();
  const images = [];
  for (const ref of refs) {
    const safe = path.resolve(REPO_ROOT, ref);
    if (!safe.startsWith(REPO_ROOT)) continue; // refuse to escape repo
    try {
      const buf = await fs.readFile(safe);
      images.push({ b64: buf.toString('base64'), mediaType: guessMedia(safe) });
    } catch (err) {
      console.warn(`[manga-sidecar] couldn't read image ${ref}:`, err.message);
    }
  }
  return { text: stripped || prompt, images };
}

function guessMedia(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}
