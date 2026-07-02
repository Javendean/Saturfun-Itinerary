import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  saveSubscription,
  deleteSubscription,
  listSubscriptions,
  countSubscriptions,
} from "../src/push-store";

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
