// HTTP route tests — ported from the kit's test_photos.py, adapted to the edge:
//  - no server-side thumbnails => has_thumb is false; thumb endpoint falls back to original
//  - DELETE is owner-gated (X-Owner-Token) per the saturfun auth decision
// Driven end-to-end through the Worker via SELF.fetch.
import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const PNG_1x1 = fromB64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);
const GIF_1x1 = fromB64("R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==");
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const OWNER = "test-owner-secret"; // matches PHOTO_OWNER_TOKEN in wrangler.test.toml
const BASE = "https://wall.test";

type Part = { name: string; bytes: Uint8Array; type: string };
function form(parts: Part[]): FormData {
  const fd = new FormData();
  for (const p of parts) fd.append("files", new File([p.bytes], p.name, { type: p.type }));
  return fd;
}
function upload(parts: Part[], headers: Record<string, string> = {}) {
  return SELF.fetch(`${BASE}/api/photos`, { method: "POST", body: form(parts), headers });
}
async function uploadOne(bytes: Uint8Array, name: string, type: string) {
  const r = await upload([{ name, bytes, type }]);
  return { r, body: (await r.json()) as any };
}

describe("photo routes", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM photos").run();
  });

  it("uploads a PNG and lists it (no stored_name leak)", async () => {
    const { r, body } = await uploadOne(PNG_1x1, "cat.png", "image/png");
    expect(r.status).toBe(200);
    expect(body.photos).toHaveLength(1);
    const p = body.photos[0];
    expect(p.content_type).toBe("image/png");
    expect(p.width).toBe(1);
    expect(p.height).toBe(1);
    expect(p.has_thumb).toBe(false); // no server-side thumbnails on the edge
    expect(p).not.toHaveProperty("stored_name");

    const listed = (await (await SELF.fetch(`${BASE}/api/photos`)).json()) as any;
    expect(listed.photos).toHaveLength(1);
    expect(listed.photos[0].id).toBe(p.id);
    expect(listed.photos[0]).not.toHaveProperty("stored_name");
  });

  it("sniffs by magic bytes, not the lying content-type/extension", async () => {
    const { r, body } = await uploadOne(PNG_1x1, "evil.exe", "application/octet-stream");
    expect(r.status).toBe(200);
    expect(body.photos[0].content_type).toBe("image/png");
    expect(body.photos[0].filename.endsWith(".png")).toBe(true);
  });

  it("serves raw bytes intact", async () => {
    const { body } = await uploadOne(PNG_1x1, "cat.png", "image/png");
    const raw = await SELF.fetch(`${BASE}/api/photos/${body.photos[0].id}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toMatch(/^image\//);
    const bytes = new Uint8Array(await raw.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_SIG);
  });

  it("serves a thumb (falls back to the original)", async () => {
    const { body } = await uploadOne(PNG_1x1, "cat.png", "image/png");
    const t = await SELF.fetch(`${BASE}/api/photos/${body.photos[0].id}/thumb`);
    expect(t.status).toBe(200);
    expect(t.headers.get("content-type")).toMatch(/^image\//);
  });

  it("download is an attachment with the filename", async () => {
    const { body } = await uploadOne(PNG_1x1, "vacation.png", "image/png");
    const d = await SELF.fetch(`${BASE}/api/photos/${body.photos[0].id}/download`);
    expect(d.status).toBe(200);
    const cd = d.headers.get("content-disposition") ?? "";
    expect(cd).toContain("attachment");
    expect(cd).toContain("vacation.png");
  });

  it("accepts GIF", async () => {
    const { r, body } = await uploadOne(GIF_1x1, "anim.gif", "image/gif");
    expect(r.status).toBe(200);
    expect(body.photos[0].content_type).toBe("image/gif");
  });

  it("rejects a non-image (400, detail mentions image)", async () => {
    const { r, body } = await uploadOne(new TextEncoder().encode("just text, not an image"), "notes.txt", "text/plain");
    expect(r.status).toBe(400);
    expect(String(body.detail).toLowerCase()).toContain("image");
  });

  it("rejects text disguised as a PNG (magic-byte sniff)", async () => {
    const { r } = await uploadOne(new TextEncoder().encode("<html>nope</html>"), "fake.png", "image/png");
    expect(r.status).toBe(400);
  });

  it("partial batch: one good + one bad => 200 with both buckets", async () => {
    const r = await upload([
      { name: "good.png", bytes: PNG_1x1, type: "image/png" },
      { name: "bad.txt", bytes: new TextEncoder().encode("nope"), type: "text/plain" },
    ]);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.photos).toHaveLength(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].filename).toBe("bad.txt");
  });

  it("507 when the total-store budget is exhausted", async () => {
    // Seed a row whose size exceeds the 3 GB cap, so the next upload is refused.
    await env.DB.prepare(
      "INSERT INTO photos (id, filename, stored_name, content_type, size, width, height, has_thumb, uploaded) VALUES (?,?,?,?,?,?,?,?,?)",
    )
      .bind("huge", "huge.png", "huge.png", "image/png", 4 * 1024 * 1024 * 1024, 1, 1, 0, 1)
      .run();
    const { r, body } = await uploadOne(PNG_1x1, "cat.png", "image/png");
    expect(r.status).toBe(507);
    expect(String(body.detail).toLowerCase()).toContain("full");
  });

  it("GET on a missing id 404s (raw/thumb/download)", async () => {
    for (const suf of ["raw", "thumb", "download"]) {
      const g = await SELF.fetch(`${BASE}/api/photos/doesnotexist/${suf}`);
      expect(g.status).toBe(404);
    }
  });

  it("rejects too many files in one request (413, write-amplification guard)", async () => {
    const parts = Array.from({ length: 21 }, (_, i) => ({ name: `f${i}.png`, bytes: PNG_1x1, type: "image/png" }));
    const r = await upload(parts);
    expect(r.status).toBe(413);
    expect(String((await r.json()).detail).toLowerCase()).toContain("many");
  });

  it("returns 404 (not 500) for a malformed percent-encoded id", async () => {
    // decodeURIComponent('%ff') throws URIError — must map to the contract's 404.
    const g = await SELF.fetch(`${BASE}/api/photos/%ff/raw`);
    expect(g.status).toBe(404);
  });

  // ---- owner-gated DELETE ----
  it("DELETE without the owner token is forbidden (403), even for a real id", async () => {
    const { body } = await uploadOne(PNG_1x1, "cat.png", "image/png");
    const id = body.photos[0].id;
    const d = await SELF.fetch(`${BASE}/api/photos/${id}`, { method: "DELETE" });
    expect(d.status).toBe(403);
    // the photo is untouched
    expect((await SELF.fetch(`${BASE}/api/photos/${id}/raw`)).status).toBe(200);
  });

  it("DELETE with a wrong token is forbidden (403)", async () => {
    const { body } = await uploadOne(PNG_1x1, "cat.png", "image/png");
    const d = await SELF.fetch(`${BASE}/api/photos/${body.photos[0].id}`, {
      method: "DELETE",
      headers: { "X-Owner-Token": "wrong" },
    });
    expect(d.status).toBe(403);
  });

  it("DELETE with the owner token removes the row and the bytes", async () => {
    const { body } = await uploadOne(PNG_1x1, "cat.png", "image/png");
    const id = body.photos[0].id;
    const d = await SELF.fetch(`${BASE}/api/photos/${id}`, {
      method: "DELETE",
      headers: { "X-Owner-Token": OWNER },
    });
    expect(d.status).toBe(200);
    expect((await d.json()) as any).toEqual({ ok: true });
    expect((await SELF.fetch(`${BASE}/api/photos/${id}/raw`)).status).toBe(404);
    const listed = (await (await SELF.fetch(`${BASE}/api/photos`)).json()) as any;
    expect(listed.photos).toEqual([]);
  });

  it("DELETE with the owner token but a missing id 404s", async () => {
    const d = await SELF.fetch(`${BASE}/api/photos/doesnotexist`, {
      method: "DELETE",
      headers: { "X-Owner-Token": OWNER },
    });
    expect(d.status).toBe(404);
  });

  // ---- CORS / origin defense-in-depth ----
  it("rejects an upload from a disallowed browser Origin (403)", async () => {
    const r = await upload([{ name: "cat.png", bytes: PNG_1x1, type: "image/png" }], {
      Origin: "https://evil.example",
    });
    expect(r.status).toBe(403);
  });

  it("echoes CORS headers for an allowed Origin on the list endpoint", async () => {
    const r = await SELF.fetch(`${BASE}/api/photos`, {
      headers: { Origin: "https://javendean.github.io" },
    });
    expect(r.headers.get("access-control-allow-origin")).toBe("https://javendean.github.io");
  });

  it("answers CORS preflight for DELETE with the owner-token header allowed", async () => {
    const r = await SELF.fetch(`${BASE}/api/photos/whatever`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://javendean.github.io",
        "Access-Control-Request-Method": "DELETE",
        "Access-Control-Request-Headers": "x-owner-token",
      },
    });
    expect(r.status).toBe(204);
    expect((r.headers.get("access-control-allow-methods") ?? "")).toContain("DELETE");
    expect((r.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain("x-owner-token");
  });
});
