// Saturfun owner-mode sidecar.
// Bridges the browser bottom-sheet chat to a local `claude -p` subprocess.
//
// Critical: ANTHROPIC_API_KEY is stripped from the spawn env. Claude Code prefers
// the API key over the OAuth subscription credentials when both are present, and
// we want subscription billing only.
//
// Modes:
//   1. Legacy local-only (default) — no SATURFUN_REMOTE_TOKEN set. All connections
//      from 127.0.0.1 accepted, no token required.
//   2. Remote-owner — SATURFUN_REMOTE_TOKEN=<passphrase>. All incoming WS
//      connections must present the passphrase via `?token=<passphrase>` query
//      param on the WS URL. The tunnel layer (cloudflared) is responsible for
//      wss/https; we still bind only to 127.0.0.1.
//
// See sidecar/REMOTE-OWNER.md for the full remote-owner setup walkthrough.
//
// Usage:
//   node sidecar/sidecar.mjs                          # legacy local-only
//   SATURFUN_REMOTE_TOKEN=<pass> node sidecar/sidecar.mjs   # remote-owner

import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = 7331;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED_TOOLS = 'Read,Edit,WebSearch,WebFetch';

const REMOTE_TOKEN = process.env.SATURFUN_REMOTE_TOKEN || null;
const REMOTE_TOKEN_BUF = REMOTE_TOKEN ? Buffer.from(REMOTE_TOKEN, 'utf8') : null;

// Constant-time string compare. Length is leaked (unavoidable for variable-length
// tokens), but the byte-wise comparison won't short-circuit on the first mismatch.
function tokensMatch(provided) {
  if (!REMOTE_TOKEN_BUF) return true;            // legacy: no auth required
  if (typeof provided !== 'string' || !provided) return false;
  const a = Buffer.from(provided, 'utf8');
  if (a.length !== REMOTE_TOKEN_BUF.length) return false;
  try { return crypto.timingSafeEqual(a, REMOTE_TOKEN_BUF); } catch { return false; }
}

function truncToken(t) {
  if (!t) return '<empty>';
  return t.length <= 4 ? '***' : `${t.slice(0, 4)}…(${t.length}c)`;
}

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });

if (REMOTE_TOKEN) {
  console.log(
    `[sidecar] listening on ws://127.0.0.1:${PORT}  cwd=${REPO_ROOT}\n` +
    `[sidecar] remote-owner mode ACTIVE — passphrase length ${REMOTE_TOKEN.length} (${truncToken(REMOTE_TOKEN)})\n` +
    `[sidecar] expose via: cloudflared tunnel --url http://127.0.0.1:${PORT}`
  );
} else {
  console.log(`[sidecar] listening on ws://127.0.0.1:${PORT}  cwd=${REPO_ROOT}  (legacy local-only mode — no token required)`);
}

wss.on('connection', (ws, req) => {
  // Extract token from query string. We rely on the tunnel for transport
  // encryption (wss); on localhost the query string never leaves the loopback.
  let providedToken = null;
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    providedToken = url.searchParams.get('token');
  } catch { /* malformed URL — leave token null */ }

  const remoteAddr = req.socket?.remoteAddress || '<unknown>';
  console.log(`[sidecar] connection attempt from ${remoteAddr}  token=${truncToken(providedToken)}`);

  if (!tokensMatch(providedToken)) {
    console.log(`[sidecar] auth REJECTED for ${remoteAddr}`);
    // 4001 = custom application close code for auth failure.
    try { ws.close(4001, 'invalid passphrase'); } catch {}
    return;
  }

  console.log(`[sidecar] auth OK for ${remoteAddr}`);

  let sessionId = null;
  let current = null;

  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

  send({ type: 'hello', repo: REPO_ROOT });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== 'prompt' || typeof msg.text !== 'string') return;

    if (current && !current.killed) {
      send({ type: 'error', message: 'previous turn still running' });
      return;
    }

    const args = [
      '-p', msg.text,
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--allowedTools', ALLOWED_TOOLS,
      '--cwd', REPO_ROOT,
    ];
    if (sessionId) args.push('--resume', sessionId);

    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    console.log(`[sidecar] spawn claude  resume=${sessionId || '<new>'}  prompt-chars=${msg.text.length}`);
    current = spawn('claude', args, { env, cwd: REPO_ROOT });
    send({ type: 'turn_start' });

    let buf = '';
    current.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.session_id && !sessionId) sessionId = evt.session_id;
          send({ type: 'event', event: evt });
        } catch (e) {
          send({ type: 'stderr', line });
        }
      }
    });

    current.stderr.on('data', (chunk) => {
      send({ type: 'stderr', line: chunk.toString() });
    });

    current.on('close', (code) => {
      console.log(`[sidecar] turn ended  code=${code}  session=${sessionId || '<none>'}`);
      send({ type: 'turn_end', code, sessionId });
      current = null;
    });

    current.on('error', (err) => {
      console.log(`[sidecar] spawn error: ${err?.message || err}`);
      send({ type: 'error', message: `spawn failed: ${err?.message || err}` });
    });
  });

  ws.on('close', () => {
    if (current && !current.killed) current.kill('SIGTERM');
  });
});

wss.on('error', (err) => {
  console.error(`[sidecar] server error: ${err?.message || err}`);
});
