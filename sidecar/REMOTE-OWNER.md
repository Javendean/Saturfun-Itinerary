# Saturfun Remote Owner Mode

Chat with your local Claude Code session from any device — friend's phone, a
hotel laptop, a borrowed tablet — by exposing the sidecar through a Cloudflare
quick tunnel and gating it with a passphrase you carry in your head.

Single-user model. You are the only person who should ever know the passphrase.
The tunnel URL is public, so the passphrase is what stops random visitors from
hijacking your Claude Code subscription.

---

## What this does

```
[friend's phone] --https--> trycloudflare.com --tunnel--> [your laptop] --localhost--> claude -p
       browser                  Cloudflare              cloudflared            sidecar.mjs
```

- Your browser on the remote device connects to a `https://*.trycloudflare.com`
  URL over wss.
- Cloudflare forwards the request through a tunnel back to your laptop's
  `127.0.0.1:7331` (the sidecar).
- The sidecar validates a passphrase you provided via env var, then spawns
  `claude -p` with `ANTHROPIC_API_KEY` stripped — same subscription billing as
  the local owner-mode path.

The browser code lives in `chat/visitor.js`. The auth code lives in
`sidecar/sidecar.mjs`.

---

## Prerequisites

1. `cloudflared` CLI installed.
   - Windows: `winget install --id Cloudflare.cloudflared`
   - macOS:   `brew install cloudflared`
   - Linux:   download from https://github.com/cloudflare/cloudflared/releases
   - Verify:  `cloudflared --version`
2. Working `claude` CLI logged into your Claude Code subscription.
3. Node ≥ 20, this repo cloned locally, `cd Saturfun`.

---

## One-time setup: generate a passphrase

```sh
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Yields something like `Abc123XyzPdq_RandomStringHere`. Save it in your password
manager. Treat it like a password — anyone who has both the tunnel URL **and**
the passphrase can drive your Claude Code session.

---

## Each session: start the sidecar with the passphrase

### PowerShell (Windows)

```powershell
$env:SATURFUN_REMOTE_TOKEN = "<your-generated-passphrase>"
node sidecar/sidecar.mjs
```

### bash / zsh

```sh
SATURFUN_REMOTE_TOKEN="<your-generated-passphrase>" node sidecar/sidecar.mjs
```

You should see:

```
[sidecar] listening on ws://127.0.0.1:7331  cwd=...
[sidecar] remote-owner mode ACTIVE — passphrase length 32 (Abc1…(32c))
[sidecar] expose via: cloudflared tunnel --url http://127.0.0.1:7331
```

Leave this terminal running.

---

## Each session: start the cloudflared quick tunnel

In a **separate** terminal:

```sh
cloudflared tunnel --url http://127.0.0.1:7331
```

After a few seconds it prints something like:

```
Your quick Tunnel has been created! Visit it at (it may take some time to be
reachable):
https://strange-cat-very-fast.trycloudflare.com
```

Copy that URL. Leave this terminal running too.

---

## On the remote device

1. Open https://javendean.github.io/Saturfun-Itinerary/ in any modern browser.
2. Tap the chat pill at the bottom of the page.
3. Tap **🔓 Owner mode (remote)** at the top of the chat sheet to expand it.
4. Paste the `https://*.trycloudflare.com` URL into **Tunnel URL**.
5. Paste your passphrase into **Passphrase**.
6. Tap **Connect**.

If everything is wired up: the status will flip to
`connected · Owner mode (remote) · Disconnect`, the header label changes to
**Owner mode (remote)**, and you can chat as if you were sitting at your
laptop. Tool calls (Read, Edit, WebSearch, WebFetch) stream back live.

The browser remembers your URL+passphrase in `localStorage` (keys
`saturfun.remoteOwner.tunnelUrl` and `saturfun.remoteOwner.passphrase`). Next
time you open the chat on that device it auto-reconnects silently. Use the
**Forget saved** button to wipe them.

---

## To revoke remote access

- Press **Ctrl+C** in the sidecar terminal. All connected remote browsers drop
  immediately and fall back to visitor mode.
- Or press **Ctrl+C** in the cloudflared terminal to kill the public URL while
  leaving the local sidecar running.
- Or click **Forget saved** in the remote browser to clear the credentials from
  that device only (the tunnel and passphrase still work elsewhere).

---

## Tunnel URL stability

`cloudflared tunnel --url ...` quick tunnels are **ephemeral** — every restart
generates a new `https://*.trycloudflare.com` URL. Convenient for occasional
use; annoying if you're constantly handing the URL to yourself across devices.

For a stable hostname, link cloudflared to your Cloudflare account and create
a **named** tunnel:

```sh
cloudflared tunnel login                      # browser opens, pick a zone
cloudflared tunnel create saturfun-sidecar    # writes ~/.cloudflared/<uuid>.json
cloudflared tunnel route dns saturfun-sidecar sidecar.yourdomain.com
cloudflared tunnel --url http://127.0.0.1:7331 run saturfun-sidecar
```

Then your remote URL is always `https://sidecar.yourdomain.com`. Docs:
https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/

---

## Security model — what to know

| Layer       | Threat                                      | Mitigation                                                         |
|-------------|---------------------------------------------|--------------------------------------------------------------------|
| Tunnel URL  | URL leaks (logs, screenshots)               | Passphrase still required to talk to the sidecar.                  |
| Passphrase  | Brute force over the public tunnel           | Use 24+ bytes of base64url entropy from `crypto.randomBytes`.      |
| In transit  | MITM on the friend's phone wifi             | Cloudflare terminates TLS; `wss://*.trycloudflare.com` is real TLS.|
| At rest     | Browser localStorage on borrowed device     | Use **Forget saved** before handing the phone back.                |
| Comparison  | Timing attacks on the token                 | Sidecar uses `crypto.timingSafeEqual` for the compare.             |
| Process     | Claude API key leaking into spawn           | Sidecar strips `ANTHROPIC_API_KEY` before each `claude -p` spawn.  |

The sidecar still only binds to `127.0.0.1` — cloudflared is the only thing
that bridges public traffic to it. If cloudflared is not running, the sidecar
is unreachable from outside even with the correct passphrase.

**Do not commit the passphrase.** It belongs in env vars and your password
manager only. There is no fallback file for it.

---

## Troubleshooting

| Symptom                                      | Likely cause / fix                                                  |
|----------------------------------------------|---------------------------------------------------------------------|
| "rejected — wrong passphrase"                | Passphrase mismatch. Re-check env var on the laptop.                |
| "could not reach tunnel"                     | cloudflared not running, or tunnel URL has changed (quick tunnels). |
| Status stays "connecting…" past 8s           | Same as above — bad URL or sidecar offline.                          |
| Chat works but no responses                  | Sidecar terminal will show spawn errors; check `claude` is on PATH. |
| Falls back to visitor mode unexpectedly      | Sidecar process exited; restart it.                                  |
| Connecting works but tools fail              | `ALLOWED_TOOLS` in sidecar.mjs limits to Read,Edit,WebSearch,WebFetch.|

---

## Legacy local-only mode (unchanged)

If you start the sidecar **without** `SATURFUN_REMOTE_TOKEN`, it runs in the
original local-only mode: no passphrase required, all 127.0.0.1 connections
accepted. The OWNER-mode handshake from `chat/chat.js` (the 500ms loopback
probe) still works exactly as before. Adding remote-owner is purely additive.
