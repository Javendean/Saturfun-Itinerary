import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { saveUpload, addPhoto } from "../src/photo-store";
import { toggleReaction } from "../src/reaction-store";
import { addComment, setAvatar } from "../src/comment-store";
import { getRecentActivity } from "../src/activity-store";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
async function seed(name = "p.png") { const m = await saveUpload(env, PNG, name); await addPhoto(env, m); return m; }

describe("activity store", () => {
  beforeEach(async () => {
    for (const t of ["reactions", "comments", "profiles", "photos"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
  });

  it("returns recent photos, reactions, comments + a latest timestamp; no device_id", async () => {
    const p = await seed("a.png");
    await toggleReaction(env, p.id, "dev-1", "🔥");
    await addComment(env, p.id, "dev-1", "wow");
    const a = await getRecentActivity(env);
    expect(a.photos[0].id).toBe(p.id);
    expect(a.reactions.map((r) => r.emoji)).toContain("🔥");
    expect(a.comments[0].body).toBe("wow");
    expect(a.comments[0]).not.toHaveProperty("device_id");
    expect(a.latest).toBeGreaterThan(0);
  });

  it("comment carries the joined name + avatar_url (opaque)", async () => {
    const p = await seed();
    await addComment(env, p.id, "dev-1", "hi");
    await setAvatar(env, "dev-1", PNG);
    const a = await getRecentActivity(env);
    expect(a.comments[0].name).toBeTruthy();
    expect(a.comments[0].avatar_url).toMatch(/^\/api\/avatar\//);
  });

  it("empty wall → empty arrays, latest 0", async () => {
    const a = await getRecentActivity(env);
    expect(a.photos).toEqual([]);
    expect(a.reactions).toEqual([]);
    expect(a.comments).toEqual([]);
    expect(a.latest).toBe(0);
  });

  it("GET /api/activity returns the shape", async () => {
    const p = await seed();
    await toggleReaction(env, p.id, "d", "❤️");
    const r = await SELF.fetch("https://wall.test/api/activity");
    expect(r.status).toBe(200);
    const j = await r.json() as any;
    expect(Array.isArray(j.photos) && Array.isArray(j.reactions) && Array.isArray(j.comments)).toBe(true);
    expect(typeof j.latest).toBe("number");
  });
});
