// Bot-aware bottom-sheet bootstrap.
// Reads <script data-bot="..."> on the loading tag and dispatches per bot:
//   saturfun → tools.js + visitor.js (visitor RAG fallback when sidecar absent)
//   manga    → manga-tools.js, owner-only (no in-browser fallback)
// Shared plumbing (DOM mount, ws handshake, owner-mode wire) lives in sheet-core.js.

import { mountSheet, tryHandshake, startOwnerWire } from './sheet-core.js';

const HANDSHAKE_MS = 500;
const SIDECAR_BY_BOT = {
  saturfun: 'ws://127.0.0.1:7331',
  manga:    'ws://127.0.0.1:7332',
};

const bot = document.currentScript?.dataset.bot || 'saturfun';
const dom = mountSheet();

(async function bootstrap() {
  const url = SIDECAR_BY_BOT[bot] || SIDECAR_BY_BOT.saturfun;
  const ws = await tryHandshake(url, HANDSHAKE_MS);

  if (ws) {
    const banner = bot === 'manga'
      ? 'Connected to manga sidecar. Opus 4.7 vision online.'
      : 'Connected to sidecar. Tool calls will edit index.html and live-reload.';
    startOwnerWire({ ws, dom, modeLabel: dom.modeLabel, modeBanner: banner });
    return;
  }

  // Sidecar unreachable. Fall back per-bot.
  if (bot === 'manga') {
    dom.modeLabel.textContent = 'Owner only';
    dom.appendBanner(
      'Owner mode only — start `node sidecar/manga-sidecar.mjs` from the repo root to chat. ' +
      'The manga page does not run a visitor in-browser model.'
    );
    return;
  }

  // saturfun: keep the existing visitor-mode dynamic import. visitor.js owns
  // the remote-owner opt-in (tunneled sidecar) — see chat/visitor.js.
  dom.modeLabel.textContent = 'Visitor mode';
  try {
    const mod = await import('./visitor.js');
    mod.init({
      append: dom.append,
      appendBanner: dom.appendBanner,
      body: dom.body,
      textarea: dom.textarea,
      sendBtn: dom.sendBtn,
      modeLabel: dom.modeLabel,
    });
  } catch (err) {
    dom.appendBanner('Visitor mode is being prepared. Check back soon.');
    console.warn('[chat] visitor module not yet available:', err);
  }
})();
