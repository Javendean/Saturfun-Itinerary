// Visitor-mode entry (Mode B).
// Stub for Phase 1 — full implementation lands in Phase 4 once the corpus exists.
// When Phase 4 lands, this module will:
//   1. fetch /data/corpus/index.json + /data/corpus/embeddings.json
//   2. lazy-import @xenova/transformers (MiniLM) on first message
//   3. cosine top-5 retrieval over the corpus
//   4. lazy-import @mlc-ai/web-llm with Qwen2.5-0.5B-Instruct
//   5. fall back to POST /api/chat (Cloudflare Worker) if WebGPU is absent

export function init({ append, appendBanner, textarea, sendBtn }) {
  appendBanner(
    'Visitor recommendations turn on once the venue corpus is populated. ' +
    'For now this chat is a preview — try opening it from a Saturfun owner terminal to use the live planner.'
  );

  function send() {
    const text = textarea.value.trim();
    if (!text) return;
    append('user', text);
    textarea.value = '';
    append('assistant', "I'm still learning Brooklyn — check back soon!");
  }
  sendBtn.addEventListener('click', send);
  textarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
  });
}
