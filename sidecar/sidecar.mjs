// Saturfun owner-mode sidecar.
// Bridges the browser bottom-sheet chat to a local `claude -p` subprocess.
//
// Critical: ANTHROPIC_API_KEY is stripped from the spawn env. Claude Code prefers
// the API key over the OAuth subscription credentials when both are present, and
// we want subscription billing only.
//
// Usage: node sidecar/sidecar.mjs

import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PORT = 7331;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED_TOOLS = 'Read,Edit,WebSearch,WebFetch';

const wss = new WebSocketServer({ port: PORT, host: '127.0.0.1' });
console.log(`[sidecar] listening on ws://127.0.0.1:${PORT}  cwd=${REPO_ROOT}`);

wss.on('connection', (ws) => {
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
      send({ type: 'turn_end', code, sessionId });
      current = null;
    });
  });

  ws.on('close', () => {
    if (current && !current.killed) current.kill('SIGTERM');
  });
});
