# Saturfun sidecar

Bridges the browser bottom-sheet chat to a local `claude -p` subprocess so the owner can shape the itinerary using their Claude Code OAuth subscription (no API billing).

## Run

```sh
# Pane 1 — sidecar
node sidecar/sidecar.mjs

# Pane 2 — static server with live reload
npx live-server --port=5173 --no-browser .
```

Open <http://127.0.0.1:5173>. The bottom-sheet pill in `index.html` will attempt a WS handshake against `ws://127.0.0.1:7331`. If that succeeds you're in owner mode (Mode A); if it doesn't, the page falls back to visitor mode (Mode B).

## Prerequisites

- Claude Code installed and logged in (`claude --version` works, you're signed into your Pro/Max subscription).
- Node 20+.
- `npm install` (only `ws` is needed for the sidecar itself).

## Security notes

- The sidecar **binds to 127.0.0.1 only**. Never tunnel this port publicly — that would proxy visitor traffic through your subscription, a direct Anthropic ToS violation (account-ban risk).
- The sidecar **strips `ANTHROPIC_API_KEY`** from the spawned `claude` process env. With both an API key and OAuth credentials present, Claude Code prefers the API key, which would bill the API. We want subscription billing only.
- `--allowedTools "Read,Edit,WebSearch,WebFetch"` is set explicitly. Without it, `claude -p` returns text only — no file mutations possible.

## Troubleshooting

- **No tool calls happen, just text.** Confirm `--allowedTools` includes `Edit`. Confirm `claude` is on PATH for the user running the sidecar.
- **Sidecar billing the API.** Check `ps eww $(pgrep -f "claude -p") | grep -c ANTHROPIC_API_KEY`. Should return `0`. If it doesn't, the env strip isn't taking effect — re-check the spawn options in `sidecar.mjs`.
- **Session loses context across turns.** The first response contains a `session_id` we capture; subsequent turns add `--resume <id>`. If you see context loss, log the captured `sessionId` and verify it's passed.
