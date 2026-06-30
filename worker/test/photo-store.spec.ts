// Storage-layer tests: R2 byte store + D1 metadata. Mirrors the kit's save_upload
// + the 5 DB methods. Each test starts with an empty (migrated) photos table thanks
// to vitest-pool-workers isolated storage.
import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import {
  saveUpload,
  addPhoto,
  getPhoto,
  listPhotos,
  deletePhoto,
  deleteFiles,
  totalPhotoBytes,
  getOriginal,
} from "../src/photo-store";

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const PNG_1x1 = fromB64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("photo store: R2 bytes + D1 metadata", () => {
  // Per-test isolation: pool isolation here is per-file, so clear rows between tests
  // (R2 leftovers are harmless — every test uses a unique stored_name).
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM photos").run();
  });

  it("saveUpload writes bytes to R2 and returns faithful metadata", async () => {
    const meta = await saveUpload(env, PNG_1x1, "cat.png");
    expect(meta.content_type).toBe("image/png");
    expect(meta.size).toBe(PNG_1x1.length);
    expect(meta.width).toBe(1);
    expect(meta.height).toBe(1);
    expect(meta.has_thumb).toBe(0);
    expect(meta.stored_name).toMatch(/^[0-9a-f]{32}\.png$/); // uuid hex + sniffed ext
    expect(meta.filename).toBe("cat.png");

    const obj = await getOriginal(env, meta.stored_name);
    expect(obj).not.toBeNull();
    const got = new Uint8Array(await obj!.arrayBuffer());
    expect(Array.from(got.slice(0, 8))).toEqual(PNG_SIG); // bytes intact
  });

  it("addPhoto + getPhoto round-trips a row", async () => {
    const meta = await saveUpload(env, PNG_1x1, "cat.png");
    await addPhoto(env, meta);
    const row = await getPhoto(env, meta.id);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(meta.id);
    expect(row!.stored_name).toBe(meta.stored_name);
    expect(row!.size).toBe(meta.size);
  });

  it("getPhoto returns null for an unknown id", async () => {
    expect(await getPhoto(env, "doesnotexist")).toBeNull();
  });

  it("listPhotos returns newest first", async () => {
    const a = await saveUpload(env, PNG_1x1, "a.png");
    a.uploaded = 1000;
    await addPhoto(env, a);
    const b = await saveUpload(env, PNG_1x1, "b.png");
    b.uploaded = 2000;
    await addPhoto(env, b);
    const list = await listPhotos(env);
    expect(list.map((p) => p.id)).toEqual([b.id, a.id]);
  });

  it("totalPhotoBytes sums sizes (0 when empty)", async () => {
    expect(await totalPhotoBytes(env)).toBe(0);
    const m = await saveUpload(env, PNG_1x1, "a.png");
    await addPhoto(env, m);
    expect(await totalPhotoBytes(env)).toBe(PNG_1x1.length);
  });

  it("deleteFiles + deletePhoto remove the bytes and the row", async () => {
    const m = await saveUpload(env, PNG_1x1, "a.png");
    await addPhoto(env, m);
    await deleteFiles(env, m.stored_name, m.id);
    await deletePhoto(env, m.id);
    expect(await getPhoto(env, m.id)).toBeNull();
    expect(await getOriginal(env, m.stored_name)).toBeNull();
  });

  it("saveUpload rejects a non-image with status 400", async () => {
    await expect(
      saveUpload(env, new TextEncoder().encode("hello, not an image at all"), "x.png"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("saveUpload rejects an oversize file with status 413", async () => {
    await expect(saveUpload(env, PNG_1x1, "x.png", 10)).rejects.toMatchObject({ status: 413 });
  });
});
