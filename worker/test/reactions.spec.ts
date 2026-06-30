import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { saveUpload, addPhoto } from "../src/photo-store";
import { isValidEmoji, reactionsFor, toggleReaction, deleteReactionsFor, listPhotosWithReactions } from "../src/reaction-store";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
async function seedPhoto(name = "p.png") { const m = await saveUpload(env, PNG, name); await addPhoto(env, m); return m; }

describe("isValidEmoji", () => {
  it("accepts real emoji incl. ZWJ + variation selectors", () => {
    for (const e of ["❤️", "😂", "‼️", "👍", "👨‍👩‍👧‍👦", "🔥"]) expect(isValidEmoji(e)).toBe(true);
  });
  it("rejects text, empty, whitespace, overlong, and non-strings", () => {
    for (const bad of ["", " ", "haha", "lol😂", "a", "<script>", "x".repeat(20), "😂😂😂😂😂😂😂😂😂", 5, null, undefined])
      expect(isValidEmoji(bad as any)).toBe(false);
  });
});

describe("reaction store", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM reactions").run();
    await env.DB.prepare("DELETE FROM photos").run();
  });

  it("toggles one emoji on/off and reports count + mine", async () => {
    const p = await seedPhoto();
    let rx = await toggleReaction(env, p.id, "dev-1", "😂");
    expect(rx).toEqual([{ emoji: "😂", count: 1, mine: true }]);
    rx = await toggleReaction(env, p.id, "dev-1", "😂");
    expect(rx).toEqual([]); // removed
  });

  it("lets one device stack multiple distinct emojis", async () => {
    const p = await seedPhoto();
    await toggleReaction(env, p.id, "dev-1", "❤️");
    const rx = await toggleReaction(env, p.id, "dev-1", "😂");
    const map = Object.fromEntries(rx.map((r) => [r.emoji, r]));
    expect(map["❤️"]).toEqual({ emoji: "❤️", count: 1, mine: true });
    expect(map["😂"]).toEqual({ emoji: "😂", count: 1, mine: true });
  });

  it("aggregates counts across devices; mine is per-device", async () => {
    const p = await seedPhoto();
    await toggleReaction(env, p.id, "dev-1", "❤️");
    await toggleReaction(env, p.id, "dev-2", "❤️");
    await toggleReaction(env, p.id, "dev-2", "🔥");
    const forDev1 = await reactionsFor(env, p.id, "dev-1");
    const heart = forDev1.find((r) => r.emoji === "❤️")!;
    const fire = forDev1.find((r) => r.emoji === "🔥")!;
    expect(heart).toEqual({ emoji: "❤️", count: 2, mine: true });
    expect(fire).toEqual({ emoji: "🔥", count: 1, mine: false });
  });

  it("listPhotosWithReactions attaches per-photo reactions; null device → mine all false", async () => {
    const p1 = await seedPhoto("a.png");
    const p2 = await seedPhoto("b.png");
    await toggleReaction(env, p1.id, "dev-1", "❤️");
    const anon = await listPhotosWithReactions(env, null);
    const byId = Object.fromEntries(anon.map((p) => [p.id, p]));
    expect(byId[p1.id].reactions).toEqual([{ emoji: "❤️", count: 1, mine: false }]);
    expect(byId[p2.id].reactions).toEqual([]);
  });

  it("deleteReactionsFor clears a photo's reactions", async () => {
    const p = await seedPhoto();
    await toggleReaction(env, p.id, "dev-1", "❤️");
    await deleteReactionsFor(env, p.id);
    expect(await reactionsFor(env, p.id, "dev-1")).toEqual([]);
  });
});

const OWNER = "test-owner-secret";
const BASE = "https://wall.test";
async function uploadOne() {
  const f = new FormData();
  f.append("files", new File([PNG], "cat.png", { type: "image/png" }));
  const r = await SELF.fetch(`${BASE}/api/photos`, { method: "POST", body: f });
  return (await r.json() as any).photos[0];
}
const react = (id: string, body: object) =>
  SELF.fetch(`${BASE}/api/photos/${id}/react`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("react routes", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM reactions").run(); await env.DB.prepare("DELETE FROM photos").run(); });

  it("POST /react toggles an emoji and returns the summary; GET ?device reflects it", async () => {
    const p = await uploadOne();
    const r1 = await react(p.id, { device_id: "dev-1", emoji: "😂" });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ reactions: [{ emoji: "😂", count: 1, mine: true }] });
    const listed = (await (await SELF.fetch(`${BASE}/api/photos?device=dev-1`)).json()) as any;
    expect(listed.photos[0].reactions).toEqual([{ emoji: "😂", count: 1, mine: true }]);
    const other = (await (await SELF.fetch(`${BASE}/api/photos?device=dev-2`)).json()) as any;
    expect(other.photos[0].reactions).toEqual([{ emoji: "😂", count: 1, mine: false }]);
  });

  it("rejects a missing device_id or invalid emoji with 400", async () => {
    const p = await uploadOne();
    expect((await react(p.id, { emoji: "😂" })).status).toBe(400);
    expect((await react(p.id, { device_id: "dev-1", emoji: "haha" })).status).toBe(400);
    expect((await react(p.id, { device_id: "dev-1", emoji: "" })).status).toBe(400);
  });

  it("non-POST to /react is 405", async () => {
    const p = await uploadOne();
    expect((await SELF.fetch(`${BASE}/api/photos/${p.id}/react`)).status).toBe(405);
  });

  it("deleting a photo (owner) clears its reactions", async () => {
    const p = await uploadOne();
    await react(p.id, { device_id: "dev-1", emoji: "❤️" });
    const del = await SELF.fetch(`${BASE}/api/photos/${p.id}`, { method: "DELETE", headers: { "X-Owner-Token": OWNER } });
    expect(del.status).toBe(200);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM reactions WHERE photo_id = ?").bind(p.id).first<number>("n");
    expect(n).toBe(0);
  });
});
