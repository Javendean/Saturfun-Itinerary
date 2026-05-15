// Saturfun bottom-sheet entry module.
// Mounts the sheet UI, attempts a ws handshake against the local sidecar.
// If the handshake doesn't complete within HANDSHAKE_MS, dynamically imports
// visitor.js (Mode B). Otherwise, stays in Mode A (owner).

const HANDSHAKE_MS = 500;
const SIDECAR_URL = 'ws://127.0.0.1:7331';

const pill = document.getElementById('chat-pill');
const sheet = document.getElementById('chat-sheet');
const body = sheet.querySelector('.sheet-body');
const closeBtn = sheet.querySelector('.sheet-close');
const textarea = sheet.querySelector('textarea');
const sendBtn = sheet.querySelector('.sheet-send');
const modeLabel = sheet.querySelector('.sheet-mode');

function openSheet() {
  sheet.dataset.open = 'true';
  pill.setAttribute('aria-expanded', 'true');
  textarea.focus();
}
function closeSheet() {
  sheet.dataset.open = 'false';
  pill.setAttribute('aria-expanded', 'false');
}
pill.addEventListener('click', openSheet);
closeBtn.addEventListener('click', closeSheet);

function append(role, text) {
  const div = document.createElement('div');
  div.className = 'sheet-msg';
  div.dataset.role = role;
  div.textContent = text;
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
  return div;
}

function appendBanner(text) {
  const div = document.createElement('div');
  div.className = 'sheet-banner';
  div.textContent = text;
  body.appendChild(div);
  body.scrollTop = body.scrollHeight;
}

// ---- Mode A wiring ---------------------------------------------------------

function startOwnerMode(ws) {
  modeLabel.textContent = 'Owner mode';
  appendBanner('Connected to sidecar. Tool calls will edit index.html and live-reload.');

  let assistantStream = null;

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'turn_start') { assistantStream = null; sendBtn.disabled = true; return; }
    if (msg.type === 'turn_end') { sendBtn.disabled = false; assistantStream = null; return; }
    if (msg.type === 'error') { append('error', msg.message); return; }

    if (msg.type !== 'event' || !msg.event) return;
    const e = msg.event;

    // Stream-json event shapes vary; handle the common ones gracefully.
    if (e.type === 'assistant' && e.message?.content) {
      for (const c of e.message.content) {
        if (c.type === 'text' && c.text) {
          if (!assistantStream) assistantStream = append('assistant', '');
          assistantStream.textContent += c.text;
        } else if (c.type === 'tool_use') {
          append('tool', `→ ${c.name}(${JSON.stringify(c.input).slice(0, 200)})`);
        }
      }
    } else if (e.type === 'result' && typeof e.result === 'string') {
      append('assistant', e.result);
    } else if (e.type === 'stream_event' && e.event?.delta?.text) {
      if (!assistantStream) assistantStream = append('assistant', '');
      assistantStream.textContent += e.event.delta.text;
    }
  });

  function send() {
    const text = textarea.value.trim();
    if (!text) return;
    append('user', text);
    textarea.value = '';
    ws.send(JSON.stringify({ type: 'prompt', text }));
  }
  sendBtn.addEventListener('click', send);
  textarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
  });
}

// ---- Bootstrap: try sidecar, fall back to visitor mode --------------------

(function bootstrap() {
  let settled = false;
  let ws;
  try { ws = new WebSocket(SIDECAR_URL); } catch { ws = null; }

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    try { ws?.close(); } catch {}
    fallback();
  }, HANDSHAKE_MS);

  if (ws) {
    ws.addEventListener('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      startOwnerMode(ws);
    });
    ws.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fallback();
    });
  } else {
    clearTimeout(timer);
    fallback();
  }

  async function fallback() {
    modeLabel.textContent = 'Visitor mode';
    try {
      const mod = await import('./visitor.js');
      mod.init({ append, appendBanner, body, textarea, sendBtn });
    } catch (err) {
      appendBanner('Visitor mode is being prepared. Check back soon.');
      console.warn('[chat] visitor module not yet available:', err);
    }
  }
})();
