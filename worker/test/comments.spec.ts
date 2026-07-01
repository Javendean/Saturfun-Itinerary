import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { saveUpload, addPhoto } from "../src/photo-store";
import { sanitizeName, sanitizeBody, setName, getName, addComment, listComments, getComment, deleteComment, deleteCommentsFor, commentCounts, setAvatar, getAvatarBytes, getAvatarId } from "../src/comment-store";

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
    const list = await listComments(env, p.id, null);
    expect(list.map((x) => x.body)).toEqual(["nice shot"]);
  });

  it("joins the profile name at read (and updates retroactively)", async () => {
    const p = await seed();
    await addComment(env, p.id, "dev-1", "first");
    await setName(env, "dev-1", "Jo");
    expect((await listComments(env, p.id, "dev-1"))[0].name).toBe("Jo");
    await setName(env, "dev-1", "Josephine"); // rename updates the existing comment's shown name
    expect((await listComments(env, p.id, "dev-1"))[0].name).toBe("Josephine");
    expect(await getName(env, "dev-1")).toBe("Josephine");
  });

  it("lists oldest-first", async () => {
    const p = await seed();
    const a = await addComment(env, p.id, "d", "one");
    const b = await addComment(env, p.id, "d", "two");
    expect(a.created).toBeLessThanOrEqual(b.created);
    expect((await listComments(env, p.id, "d")).map((x) => x.body)).toEqual(["one", "two"]);
  });

  it("mine flag: true for requester's own comment, false for another device's, false when null", async () => {
    const p = await seed();
    await addComment(env, p.id, "dev-1", "mine");
    await addComment(env, p.id, "dev-2", "theirs");
    const list = await listComments(env, p.id, "dev-1");
    expect(list).toHaveLength(2);
    expect(list[0].mine).toBe(true);
    expect(list[1].mine).toBe(false);
    // device_id must NOT appear in list results
    expect(list[0]).not.toHaveProperty("device_id");
    expect(list[1]).not.toHaveProperty("device_id");
    // null device → mine always false
    const guestList = await listComments(env, p.id, null);
    expect(guestList[0].mine).toBe(false);
    expect(guestList[1].mine).toBe(false);
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

// ---------------------------------------------------------------------------
// Route integration tests (via SELF.fetch)
// ---------------------------------------------------------------------------
const OWNER = "test-owner-secret";
const BASE = "https://wall.test";
async function uploadOne() {
  const f = new FormData(); f.append("files", new File([PNG], "c.png", { type: "image/png" }));
  return (await (await SELF.fetch(`${BASE}/api/photos`, { method: "POST", body: f })).json() as any).photos[0];
}
const postComment = (id: string, b: object) => SELF.fetch(`${BASE}/api/photos/${id}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });

describe("comment routes", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM comments").run(); await env.DB.prepare("DELETE FROM profiles").run(); await env.DB.prepare("DELETE FROM photos").run(); });

  it("posts + lists a comment; name via profile; comment_count in the list", async () => {
    const p = await uploadOne();
    await SELF.fetch(`${BASE}/api/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: "d1", name: "Ada" }) });
    const r = await postComment(p.id, { device_id: "d1", body: "hi there" });
    expect(r.status).toBe(201);
    expect((await r.json() as any).name).toBe("Ada");
    const list = await (await SELF.fetch(`${BASE}/api/photos/${p.id}/comments?device=d1`)).json() as any;
    expect(list.comments.map((c: any) => c.body)).toEqual(["hi there"]);
    expect(list.comments[0].mine).toBe(true);           // d1's own comment
    expect(list.comments[0].device_id).toBeUndefined(); // device_id must NOT be exposed
    const photos = await (await SELF.fetch(`${BASE}/api/photos?device=d1`)).json() as any;
    expect(photos.photos[0].comment_count).toBe(1);
  });

  it("rejects empty body (400)", async () => {
    const p = await uploadOne();
    expect((await postComment(p.id, { device_id: "d1", body: "   " })).status).toBe(400);
    expect((await postComment(p.id, { device_id: "d1" })).status).toBe(400);
  });

  it("author deletes own; a stranger cannot (403); owner deletes any", async () => {
    const p = await uploadOne();
    const c1 = await (await postComment(p.id, { device_id: "d1", body: "mine" })).json() as any;
    // stranger device → 403
    expect((await SELF.fetch(`${BASE}/api/photos/${p.id}/comments/${c1.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: "d2" }) })).status).toBe(403);
    // author → 200
    expect((await SELF.fetch(`${BASE}/api/photos/${p.id}/comments/${c1.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: "d1" }) })).status).toBe(200);
    // owner deletes any
    const c2 = await (await postComment(p.id, { device_id: "d1", body: "again" })).json() as any;
    expect((await SELF.fetch(`${BASE}/api/photos/${p.id}/comments/${c2.id}`, { method: "DELETE", headers: { "X-Owner-Token": OWNER } })).status).toBe(200);
  });

  it("PUT /profile validates the name; GET returns it", async () => {
    expect((await SELF.fetch(`${BASE}/api/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: "d1", name: "  " }) })).status).toBe(400);
    await SELF.fetch(`${BASE}/api/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: "d1", name: "Grace" }) });
    expect((await (await SELF.fetch(`${BASE}/api/profile/d1`)).json() as any).name).toBe("Grace");
  });

  it("deleting a photo cascades its comments", async () => {
    const p = await uploadOne();
    await postComment(p.id, { device_id: "d1", body: "x" });
    await SELF.fetch(`${BASE}/api/photos/${p.id}`, { method: "DELETE", headers: { "X-Owner-Token": OWNER } });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE photo_id = ?").bind(p.id).first<number>("n");
    expect(n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Avatar store tests
// ---------------------------------------------------------------------------
const GIFBYTES = Uint8Array.from(atob("R0lGODlhAQABAAAAACwAAAAAAQABAAA="), (c) => c.charCodeAt(0));

describe("avatars", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM comments").run();
    await env.DB.prepare("DELETE FROM profiles").run();
    await env.DB.prepare("DELETE FROM photos").run();
  });

  it("stores an avatar, sets avatar_id, serves the bytes", async () => {
    const { avatar_id } = await setAvatar(env, "dev-1", PNG);
    expect(typeof avatar_id).toBe("string");
    expect(avatar_id.length).toBeGreaterThan(8);
    expect(await getAvatarId(env, "dev-1")).toBe(avatar_id);
    const got = await getAvatarBytes(env, avatar_id);
    expect(got).not.toBeNull();
    expect(got!.contentType).toContain("image/");
    expect(new Uint8Array(got!.body).length).toBe(PNG.length);
  });

  it("rejects a non-image (magic-byte validation)", async () => {
    await expect(setAvatar(env, "dev-1", Uint8Array.from([1, 2, 3, 4, 5]))).rejects.toBeTruthy();
  });

  it("re-upload keeps a stable avatar_id for the device", async () => {
    const a = await setAvatar(env, "dev-1", PNG);
    const b = await setAvatar(env, "dev-1", GIFBYTES);
    expect(b.avatar_id).toBe(a.avatar_id);
  });

  it("listComments includes avatar_url when the commenter has an avatar", async () => {
    const m = await saveUpload(env, PNG, "p.png"); await addPhoto(env, m);
    await addComment(env, m.id, "dev-1", "hi");
    const before = await listComments(env, m.id, "dev-1");
    expect(before[0].avatar_url).toBeNull();
    const { avatar_id } = await setAvatar(env, "dev-1", PNG);
    const after = await listComments(env, m.id, "dev-1");
    expect(after[0].avatar_url).toBe(`/api/avatar/${avatar_id}`);
  });
});

// ---------------------------------------------------------------------------
// Avatar route integration tests (via SELF.fetch)
// ---------------------------------------------------------------------------
describe("avatar routes", () => {
  beforeEach(async () => { await env.DB.prepare("DELETE FROM profiles").run(); });
  it("uploads an avatar (multipart) then serves it; comment shows avatar_url", async () => {
    const f = new FormData();
    f.append("device_id", "d1");
    f.append("avatar", new File([PNG], "a.png", { type: "image/png" }));
    const up = await SELF.fetch(`${BASE}/api/profile/avatar`, { method: "POST", body: f });
    expect(up.status).toBe(200);
    const url = (await up.json() as any).avatar_url as string;
    expect(url).toMatch(/^\/api\/avatar\//);
    const img = await SELF.fetch(`${BASE}${url}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toContain("image/");
    expect(img.headers.get("cache-control") || "").not.toContain("immutable");
  });
  it("rejects a non-image upload", async () => {
    const f = new FormData();
    f.append("device_id", "d1");
    f.append("avatar", new File([Uint8Array.from([1,2,3,4])], "x.bin", { type: "image/png" }));
    expect((await SELF.fetch(`${BASE}/api/profile/avatar`, { method: "POST", body: f })).status).toBe(400);
  });
  it("GET unknown avatar → 404", async () => {
    expect((await SELF.fetch(`${BASE}/api/avatar/nope`)).status).toBe(404);
  });
  it("rejects a non-multipart body with 400", async () => {
    const r = await SELF.fetch(`${BASE}/api/profile/avatar`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: "d1" }) });
    expect(r.status).toBe(400);
  });
});
