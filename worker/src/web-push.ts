import type { Env } from "./types";
import type { PushSub } from "./push-store";
import { listSubscriptions, deleteSubscription } from "./push-store";

function b64urlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  s += "=".repeat(pad);
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export { b64urlToBytes };

function bytesToB64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jsonB64url(o: unknown): string {
  return bytesToB64url(new TextEncoder().encode(JSON.stringify(o)));
}

// Sign a VAPID JWT (ES256) with the private key JWK stored in the VAPID_PRIVATE_KEY secret.
export async function vapidAuthHeader(audience: string, env: Env): Promise<string> {
  const raw = (env as unknown as Record<string, string>).VAPID_PRIVATE_KEY;
  if (!raw) throw new Error("VAPID_PRIVATE_KEY not configured");
  const jwk = JSON.parse(raw); // {kty:"EC",crv:"P-256",x,y,d}
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = jsonB64url({ typ: "JWT", alg: "ES256" });
  const payload = jsonB64url({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: (env as unknown as Record<string, string>).VAPID_SUBJECT || "mailto:owner@saturfun",
  });
  const signingInput = `${header}.${payload}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      new TextEncoder().encode(signingInput),
    ),
  );
  // Web Crypto returns raw r||s (64 bytes) which is exactly JWS ES256 format.
  return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${(env as unknown as Record<string, string>).VAPID_PUBLIC_KEY}`;
}

export async function sendTickle(env: Env, sub: PushSub): Promise<number> {
  const url = new URL(sub.endpoint);
  const auth = await vapidAuthHeader(`${url.protocol}//${url.host}`, env);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: auth,
      TTL: "86400",
      Urgency: "normal",
      "Content-Length": "0",
    },
  });
  return res.status;
}

export async function sendToAll(env: Env): Promise<{ sent: number; pruned: number }> {
  const subs = await listSubscriptions(env);
  let sent = 0,
    pruned = 0;
  for (const sub of subs) {
    let status = 0;
    try {
      status = await sendTickle(env, sub);
    } catch {
      status = 0;
    }
    if (status === 404 || status === 410) {
      try { await deleteSubscription(env, sub.endpoint); pruned++; } catch { /* skip; don't abort the loop */ }
    } else if (status >= 200 && status < 300) {
      sent++;
    }
  }
  return { sent, pruned };
}
