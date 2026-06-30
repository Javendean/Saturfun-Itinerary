import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { saveUpload, addPhoto } from "../src/photo-store";
import { toggleLike, likeCount, hasLiked, deleteLikesFor, listPhotosWithLikes } from "../src/like-store";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

async function seedPhoto(name = "p.png") {
  const m = await saveUpload(env, PNG, name);
  await addPhoto(env, m);
  return m;
}

describe("like store", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM likes").run();
    await env.DB.prepare("DELETE FROM photos").run();
  });

  it("toggles a like on then off, with an accurate count", async () => {
    const p = await seedPhoto();
    const a = await toggleLike(env, p.id, "dev-1");
    expect(a).toEqual({ liked: true, count: 1 });
    expect(await hasLiked(env, p.id, "dev-1")).toBe(true);
    const b = await toggleLike(env, p.id, "dev-1");
    expect(b).toEqual({ liked: false, count: 0 });
    expect(await hasLiked(env, p.id, "dev-1")).toBe(false);
  });

  it("dedupes — a second device adds a second like; same device does not double-count", async () => {
    const p = await seedPhoto();
    await toggleLike(env, p.id, "dev-1");
    await toggleLike(env, p.id, "dev-2");
    expect(await likeCount(env, p.id)).toBe(2);
    // dev-1 toggling off leaves dev-2's like
    await toggleLike(env, p.id, "dev-1");
    expect(await likeCount(env, p.id)).toBe(1);
  });

  it("listPhotosWithLikes returns counts + this device's liked flag", async () => {
    const p1 = await seedPhoto("a.png");
    const p2 = await seedPhoto("b.png");
    await toggleLike(env, p1.id, "dev-1");
    await toggleLike(env, p1.id, "dev-2");
    const list = await listPhotosWithLikes(env, "dev-1");
    const byId = Object.fromEntries(list.map((p) => [p.id, p]));
    expect(byId[p1.id].like_count).toBe(2);
    expect(byId[p1.id].liked).toBe(true);
    expect(byId[p2.id].like_count).toBe(0);
    expect(byId[p2.id].liked).toBe(false);
  });

  it("listPhotosWithLikes with a null device → liked is always false", async () => {
    const p = await seedPhoto();
    await toggleLike(env, p.id, "dev-1");
    const list = await listPhotosWithLikes(env, null);
    expect(list[0].like_count).toBe(1);
    expect(list[0].liked).toBe(false);
  });

  it("deleteLikesFor removes a photo's likes", async () => {
    const p = await seedPhoto();
    await toggleLike(env, p.id, "dev-1");
    await deleteLikesFor(env, p.id);
    expect(await likeCount(env, p.id)).toBe(0);
  });
});

const OWNER = "test-owner-secret";
const BASE = "https://wall.test";
const fd1 = () => {
  const f = new FormData();
  f.append("files", new File([PNG], "cat.png", { type: "image/png" }));
  return f;
};
async function uploadOne() {
  const r = await SELF.fetch(`${BASE}/api/photos`, { method: "POST", body: fd1() });
  return (await r.json() as any).photos[0];
}

describe("like routes", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM likes").run();
    await env.DB.prepare("DELETE FROM photos").run();
  });

  it("POST /like toggles and returns {liked,count}; GET ?device reflects it", async () => {
    const p = await uploadOne();
    const r1 = await SELF.fetch(`${BASE}/api/photos/${p.id}/like`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "dev-1" }),
    });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ liked: true, count: 1 });

    const listed = (await (await SELF.fetch(`${BASE}/api/photos?device=dev-1`)).json()) as any;
    expect(listed.photos[0].like_count).toBe(1);
    expect(listed.photos[0].liked).toBe(true);

    // a different device does not see "liked"
    const other = (await (await SELF.fetch(`${BASE}/api/photos?device=dev-2`)).json()) as any;
    expect(other.photos[0].like_count).toBe(1);
    expect(other.photos[0].liked).toBe(false);

    // toggle off
    const r2 = await SELF.fetch(`${BASE}/api/photos/${p.id}/like`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "dev-1" }),
    });
    expect(await r2.json()).toEqual({ liked: false, count: 0 });
  });

  it("POST /like requires a device_id (400 without it)", async () => {
    const p = await uploadOne();
    const r = await SELF.fetch(`${BASE}/api/photos/${p.id}/like`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    expect(r.status).toBe(400);
  });

  it("deleting a photo (owner) clears its likes", async () => {
    const p = await uploadOne();
    await SELF.fetch(`${BASE}/api/photos/${p.id}/like`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "dev-1" }),
    });
    const del = await SELF.fetch(`${BASE}/api/photos/${p.id}`, { method: "DELETE", headers: { "X-Owner-Token": OWNER } });
    expect(del.status).toBe(200);
    const leftover = await env.DB.prepare("SELECT COUNT(*) AS n FROM likes WHERE photo_id = ?").bind(p.id).first<number>("n");
    expect(leftover).toBe(0);
  });
});
