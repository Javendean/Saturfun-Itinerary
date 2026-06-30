import { env } from "cloudflare:test";
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
