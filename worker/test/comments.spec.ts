import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { saveUpload, addPhoto } from "../src/photo-store";
import { sanitizeName, sanitizeBody, setName, getName, addComment, listComments, getComment, deleteComment, deleteCommentsFor, commentCounts } from "../src/comment-store";

const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
async function seed(name = "p.png") { const m = await saveUpload(env, PNG, name); await addPhoto(env, m); return m; }

describe("comment validation", () => {
  it("name: trims, caps 40, rejects empty", () => {
    expect(sanitizeName("  Jo  ")).toBe("Jo");
    expect(sanitizeName("")).toBeNull();
    expect(sanitizeName("   ")).toBeNull();
    expect(sanitizeName("x".repeat(41))).toBe("x".repeat(40));
    expect(sanitizeName(5 as any)).toBeNull();
  });
  it("body: trims, caps 500, rejects empty", () => {
    expect(sanitizeBody(" hi ")).toBe("hi");
    expect(sanitizeBody("")).toBeNull();
    expect(sanitizeBody("x".repeat(501))).toBe("x".repeat(500));
  });
});

describe("comment store", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM comments").run();
    await env.DB.prepare("DELETE FROM profiles").run();
    await env.DB.prepare("DELETE FROM photos").run();
  });

  it("adds a comment; name falls back to Someone without a profile", async () => {
    const p = await seed();
    const c = await addComment(env, p.id, "dev-1", "nice shot");
    expect(c.body).toBe("nice shot");
    expect(c.name).toBe("Someone");
    const list = await listComments(env, p.id);
    expect(list.map((x) => x.body)).toEqual(["nice shot"]);
  });

  it("joins the profile name at read (and updates retroactively)", async () => {
    const p = await seed();
    await addComment(env, p.id, "dev-1", "first");
    await setName(env, "dev-1", "Jo");
    expect((await listComments(env, p.id))[0].name).toBe("Jo");
    await setName(env, "dev-1", "Josephine"); // rename updates the existing comment's shown name
    expect((await listComments(env, p.id))[0].name).toBe("Josephine");
    expect(await getName(env, "dev-1")).toBe("Josephine");
  });

  it("lists oldest-first", async () => {
    const p = await seed();
    const a = await addComment(env, p.id, "d", "one");
    const b = await addComment(env, p.id, "d", "two");
    expect(a.created).toBeLessThanOrEqual(b.created);
    expect((await listComments(env, p.id)).map((x) => x.body)).toEqual(["one", "two"]);
  });

  it("getComment returns the author device; delete removes it", async () => {
    const p = await seed();
    const c = await addComment(env, p.id, "dev-9", "x");
    expect((await getComment(env, c.id))!.device_id).toBe("dev-9");
    await deleteComment(env, c.id);
    expect(await getComment(env, c.id)).toBeNull();
  });

  it("counts per photo + cascade delete", async () => {
    const p1 = await seed("a.png"); const p2 = await seed("b.png");
    await addComment(env, p1.id, "d", "1"); await addComment(env, p1.id, "d", "2");
    expect((await commentCounts(env))[p1.id]).toBe(2);
    expect((await commentCounts(env))[p2.id]).toBeUndefined();
    await deleteCommentsFor(env, p1.id);
    expect((await commentCounts(env))[p1.id]).toBeUndefined();
  });
});
