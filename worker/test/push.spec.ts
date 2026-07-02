import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  saveSubscription,
  deleteSubscription,
  listSubscriptions,
  countSubscriptions,
} from "../src/push-store";
import { vapidAuthHeader } from "../src/web-push";

const SUB_A = {
  endpoint: "https://push.example.com/sub/aaa",
  p256dh: "BNcR8VFsIcAPMn0s9RwFJBSVGmrC7TkjXFb5gQidHlk",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

const SUB_B = {
  endpoint: "https://push.example.com/sub/bbb",
  p256dh: "BMf3VyZm6C0bW3MG_sHCRzJvT8Rgl5dVkSyxuZ4",
  auth: "u9KV3wqL8xP2mN0dE5oFiA",
};

describe("saveSubscription", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
  });

  it("inserts a new subscription", async () => {
    await saveSubscription(env, "dev-1", SUB_A);
    const count = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?")
      .bind(SUB_A.endpoint)
      .first<number>("n");
    expect(count).toBe(1);
  });

  it("stores device_id, p256dh, and auth correctly", async () => {
    await saveSubscription(env, "dev-1", SUB_A);
    const row = await env.DB
      .prepare("SELECT device_id, p256dh, auth FROM push_subscriptions WHERE endpoint = ?")
      .bind(SUB_A.endpoint)
      .first<{ device_id: string; p256dh: string; auth: string }>();
    expect(row).not.toBeNull();
    expect(row!.device_id).toBe("dev-1");
    expect(row!.p256dh).toBe(SUB_A.p256dh);
    expect(row!.auth).toBe(SUB_A.auth);
  });

  it("is idempotent — calling twice with same endpoint does not create a duplicate", async () => {
    await saveSubscription(env, "dev-1", SUB_A);
    await saveSubscription(env, "dev-1", SUB_A);
    const count = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?")
      .bind(SUB_A.endpoint)
      .first<number>("n");
    expect(count).toBe(1);
  });

  it("upsert updates device_id and keys when same endpoint is reused", async () => {
    await saveSubscription(env, "dev-1", SUB_A);
    const updated = { ...SUB_A, p256dh: "UPDATED_P256DH", auth: "UPDATED_AUTH" };
    await saveSubscription(env, "dev-2", updated);
    const row = await env.DB
      .prepare("SELECT device_id, p256dh, auth FROM push_subscriptions WHERE endpoint = ?")
      .bind(SUB_A.endpoint)
      .first<{ device_id: string; p256dh: string; auth: string }>();
    expect(row!.device_id).toBe("dev-2");
    expect(row!.p256dh).toBe("UPDATED_P256DH");
    expect(row!.auth).toBe("UPDATED_AUTH");
  });
});

describe("listSubscriptions", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
  });

  it("returns empty array when no subscriptions exist", async () => {
    expect(await listSubscriptions(env)).toEqual([]);
  });

  it("returns all subscriptions with {endpoint, p256dh, auth} shape", async () => {
    await saveSubscription(env, "dev-1", SUB_A);
    await saveSubscription(env, "dev-2", SUB_B);
    const subs = await listSubscriptions(env);
    expect(subs).toHaveLength(2);
    for (const s of subs) {
      expect(typeof s.endpoint).toBe("string");
      expect(typeof s.p256dh).toBe("string");
      expect(typeof s.auth).toBe("string");
    }
  });

  it("returned objects contain the correct endpoint, p256dh, auth values", async () => {
    await saveSubscription(env, "dev-1", SUB_A);
    const subs = await listSubscriptions(env);
    expect(subs).toHaveLength(1);
    expect(subs[0].endpoint).toBe(SUB_A.endpoint);
    expect(subs[0].p256dh).toBe(SUB_A.p256dh);
    expect(subs[0].auth).toBe(SUB_A.auth);
  });
});

describe("deleteSubscription", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
  });

  it("removes the subscription for the given endpoint", async () => {
    await saveSubscription(env, "dev-1", SUB_A);
    await deleteSubscription(env, SUB_A.endpoint);
    const count = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?")
      .bind(SUB_A.endpoint)
      .first<number>("n");
    expect(count).toBe(0);
  });

  it("does not affect other subscriptions", async () => {
    await saveSubscription(env, "dev-1", SUB_A);
    await saveSubscription(env, "dev-2", SUB_B);
    await deleteSubscription(env, SUB_A.endpoint);
    const remaining = await listSubscriptions(env);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].endpoint).toBe(SUB_B.endpoint);
  });

  it("no-ops silently when endpoint does not exist", async () => {
    await expect(deleteSubscription(env, "https://nonexistent.example.com/sub")).resolves.toBeUndefined();
  });
});

describe("countSubscriptions", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
  });

  it("returns 0 when table is empty", async () => {
    expect(await countSubscriptions(env)).toBe(0);
  });

  it("returns correct count after inserts", async () => {
    await saveSubscription(env, "dev-1", SUB_A);
    expect(await countSubscriptions(env)).toBe(1);
    await saveSubscription(env, "dev-2", SUB_B);
    expect(await countSubscriptions(env)).toBe(2);
  });

  it("count decrements after delete", async () => {
    await saveSubscription(env, "dev-1", SUB_A);
    await saveSubscription(env, "dev-2", SUB_B);
    await deleteSubscription(env, SUB_A.endpoint);
    expect(await countSubscriptions(env)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// HTTP route tests — /api/push/*
// ---------------------------------------------------------------------------

const BASE = "https://wall.test";
const OWNER = "test-owner-secret";

const VALID_SUB = {
  device_id: "dev-http-1",
  subscription: {
    endpoint: "https://push.example.com/http/aaa",
    keys: {
      p256dh: "BNcR8VFsIcAPMn0s9RwFJBSVGmrC7TkjXFb5gQidHlk",
      auth: "tBHItJI5svbpez7KI4CCXg",
    },
  },
};

describe("GET /api/push/key", () => {
  it("returns the configured VAPID public key", async () => {
    const r = await SELF.fetch(`${BASE}/api/push/key`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { key: string };
    expect(body.key).toBe(env.VAPID_PUBLIC_KEY);
    expect(body.key.length).toBeGreaterThan(0);
  });

  it("rejects non-GET methods with 405", async () => {
    const r = await SELF.fetch(`${BASE}/api/push/key`, { method: "POST" });
    expect(r.status).toBe(405);
  });
});

describe("GET /api/push/digest", () => {
  it("returns static digest payload", async () => {
    const r = await SELF.fetch(`${BASE}/api/push/digest`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { title: string; body: string; url: string };
    expect(body.title).toBe("Saturfun");
    expect(body.body).toBe("Open Saturfun to see what's new.");
    expect(body.url).toBe("plan.html");
  });
});

describe("POST /api/push/subscribe", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
  });

  it("stores a valid subscription and returns {ok:true}", async () => {
    const r = await SELF.fetch(`${BASE}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_SUB),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const subs = await listSubscriptions(env);
    expect(subs).toHaveLength(1);
    expect(subs[0].endpoint).toBe(VALID_SUB.subscription.endpoint);
  });

  it("returns 400 when device_id is missing", async () => {
    const r = await SELF.fetch(`${BASE}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: VALID_SUB.subscription }),
    });
    expect(r.status).toBe(400);
  });

  it("returns 400 when subscription.endpoint is missing", async () => {
    const r = await SELF.fetch(`${BASE}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "dev-1", subscription: { keys: VALID_SUB.subscription.keys } }),
    });
    expect(r.status).toBe(400);
  });

  it("returns 400 when subscription.keys is missing", async () => {
    const r = await SELF.fetch(`${BASE}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "dev-1", subscription: { endpoint: VALID_SUB.subscription.endpoint } }),
    });
    expect(r.status).toBe(400);
  });

  it("returns 400 when body is not JSON", async () => {
    const r = await SELF.fetch(`${BASE}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(r.status).toBe(400);
  });
});

describe("POST /api/push/unsubscribe", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
  });

  it("removes an existing subscription and returns {ok:true}", async () => {
    await saveSubscription(env, "dev-1", {
      endpoint: VALID_SUB.subscription.endpoint,
      p256dh: VALID_SUB.subscription.keys.p256dh,
      auth: VALID_SUB.subscription.keys.auth,
    });
    const r = await SELF.fetch(`${BASE}/api/push/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: VALID_SUB.subscription.endpoint }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const subs = await listSubscriptions(env);
    expect(subs).toHaveLength(0);
  });

  it("returns 400 when endpoint is missing", async () => {
    const r = await SELF.fetch(`${BASE}/api/push/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });
});

describe("POST /api/push/test", () => {
  it("returns 403 without owner token", async () => {
    const r = await SELF.fetch(`${BASE}/api/push/test`, { method: "POST" });
    expect(r.status).toBe(403);
  });

  it("returns 403 with wrong owner token", async () => {
    const r = await SELF.fetch(`${BASE}/api/push/test`, {
      method: "POST",
      headers: { "X-Owner-Token": "wrong-token" },
    });
    expect(r.status).toBe(403);
  });

  it("returns {sent, pruned} with valid owner token (no subs → sent=0, pruned=0)", async () => {
    await env.DB.prepare("DELETE FROM push_subscriptions").run();
    const r = await SELF.fetch(`${BASE}/api/push/test`, {
      method: "POST",
      headers: { "X-Owner-Token": OWNER },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { sent: number; pruned: number };
    expect(typeof body.sent).toBe("number");
    expect(typeof body.pruned).toBe("number");
  });
});

describe("vapidAuthHeader", () => {
  it("returns a string starting with 'vapid t='", async () => {
    const header = await vapidAuthHeader("https://push.example.com", env);
    expect(header.startsWith("vapid t=")).toBe(true);
  });

  it("the JWT token has exactly three base64url segments (header.payload.sig)", async () => {
    const header = await vapidAuthHeader("https://push.example.com", env);
    // Format: vapid t=<jwt>, k=<pubkey>
    const match = header.match(/^vapid t=([^,]+),/);
    expect(match).not.toBeNull();
    const jwt = match![1];
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    // All three parts should be non-empty base64url strings
    for (const part of parts) {
      expect(part.length).toBeGreaterThan(0);
      expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("the JWT header decodes to {typ:'JWT', alg:'ES256'}", async () => {
    const header = await vapidAuthHeader("https://push.example.com", env);
    const match = header.match(/^vapid t=([^,]+),/);
    const jwt = match![1];
    const headerPart = jwt.split(".")[0];
    // Decode base64url
    const padded = headerPart.replace(/-/g, "+").replace(/_/g, "/") + "==".slice((headerPart.length % 4 || 4) - 2);
    const decoded = JSON.parse(atob(padded));
    expect(decoded.alg).toBe("ES256");
    expect(decoded.typ).toBe("JWT");
  });

  it("the JWT payload contains aud, exp, sub fields", async () => {
    const audience = "https://push.example.com";
    const header = await vapidAuthHeader(audience, env);
    const match = header.match(/^vapid t=([^,]+),/);
    const jwt = match![1];
    const payloadPart = jwt.split(".")[1];
    const padded = payloadPart.replace(/-/g, "+").replace(/_/g, "/") + "==".slice((payloadPart.length % 4 || 4) - 2);
    const payload = JSON.parse(atob(padded));
    expect(payload.aud).toBe(audience);
    expect(typeof payload.exp).toBe("number");
    expect(typeof payload.sub).toBe("string");
  });

  it("includes the public key after ', k='", async () => {
    const header = await vapidAuthHeader("https://push.example.com", env);
    expect(header).toContain(`, k=${env.VAPID_PUBLIC_KEY}`);
  });
});
