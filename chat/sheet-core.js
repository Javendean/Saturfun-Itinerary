// Shared bottom-sheet plumbing.
// Mounts DOM handles + a sidecar handshake helper. Bot-specific bootstraps
// (chat.js for saturfun, the manga branch for /manga.html) call into this so
// nothing about the WebSocket wire / DOM pattern lives in two places.

export function mountSheet() {
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
    return div;
  }

  return { pill, sheet, body, closeBtn, textarea, sendBtn, modeLabel, append, appendBanner, openSheet, closeSheet };
}

// Try opening a WebSocket to the local sidecar. Resolves with the live socket
// on `open`, or null if it doesn't connect within timeoutMs. Caller is
// responsible for whatever happens next (start owner mode vs. fallback).
export function tryHandshake(url, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    let ws;
    try { ws = new WebSocket(url); } catch { resolve(null); return; }

    const finish = (val) => { if (settled) return; settled = true; resolve(val); };
    const timer = setTimeout(() => { try { ws?.close(); } catch {} finish(null); }, timeoutMs);

    ws.addEventListener('open', () => { clearTimeout(timer); finish(ws); });
    ws.addEventListener('error', () => { clearTimeout(timer); finish(null); });
  });
}

// Standard owner-mode wire: forwards stream-json events into the sheet,
// handles the prompt/turn protocol. Both saturfun and manga share this exact
// shape because the sidecar JSON envelope is identical.
export function startOwnerWire({ ws, dom, modeLabel, modeBanner }) {
  modeLabel.textContent = 'Owner mode';
  if (modeBanner) dom.appendBanner(modeBanner);

  let assistantStream = null;

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'turn_start') { assistantStream = null; dom.sendBtn.disabled = true; return; }
    if (msg.type === 'turn_end')   { dom.sendBtn.disabled = false; assistantStream = null; return; }
    if (msg.type === 'error')      { dom.append('error', msg.message); return; }

    if (msg.type !== 'event' || !msg.event) return;
    const e = msg.event;
    if (e.type === 'assistant' && e.message?.content) {
      for (const c of e.message.content) {
        if (c.type === 'text' && c.text) {
          if (!assistantStream) assistantStream = dom.append('assistant', '');
          assistantStream.textContent += c.text;
        } else if (c.type === 'tool_use') {
          dom.append('tool', `→ ${c.name}(${JSON.stringify(c.input).slice(0, 200)})`);
        }
      }
    } else if (e.type === 'result' && typeof e.result === 'string') {
      dom.append('assistant', e.result);
    } else if (e.type === 'stream_event' && e.event?.delta?.text) {
      if (!assistantStream) assistantStream = dom.append('assistant', '');
      assistantStream.textContent += e.event.delta.text;
    }
  });

  function send() {
    const text = dom.textarea.value.trim();
    if (!text) return;
    dom.append('user', text);
    dom.textarea.value = '';
    ws.send(JSON.stringify({ type: 'prompt', text }));
  }
  dom.sendBtn.addEventListener('click', send);
  dom.textarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
  });
}
