// Pure-logic unit tests for the photos module — the security boundary.
// Ported from the kit's test_sniff_image_signatures + test_sanitize_filename,
// plus imageDimensions (replaces Pillow's dimension probing on the edge).
import { describe, it, expect } from "vitest";
import { sniffImage, sanitizeFilename, imageDimensions } from "../src/photos";

// Latin1 string -> bytes (each \xNN char-code maps 1:1 to a byte, like Python b"...").
const b = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
// base64 -> bytes (atob is available in workerd).
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Real 1x1 red PNG (67 bytes) and a minimal 1x1 GIF87a — same assets the kit uses.
const PNG_1x1 = fromB64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);
const GIF_1x1 = fromB64("R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==");

describe("sniffImage — magic-byte detection (never trusts content-type)", () => {
  it("detects JPEG", () => {
    expect(sniffImage(b("\xff\xd8\xff\xe0abcd"))).toEqual({ contentType: "image/jpeg", ext: ".jpg" });
  });
  it("detects PNG", () => {
    expect(sniffImage(b("\x89PNG\r\n\x1a\n...."))).toEqual({ contentType: "image/png", ext: ".png" });
  });
  it("detects GIF", () => {
    expect(sniffImage(b("GIF89a.........."))).toEqual({ contentType: "image/gif", ext: ".gif" });
  });
  it("detects WEBP", () => {
    expect(sniffImage(b("RIFF\x00\x00\x00\x00WEBPVP8 "))).toEqual({ contentType: "image/webp", ext: ".webp" });
  });
  it("detects BMP", () => {
    expect(sniffImage(b("BM.............."))).toEqual({ contentType: "image/bmp", ext: ".bmp" });
  });
  it("detects HEIC (ftyp box)", () => {
    expect(sniffImage(b("\x00\x00\x00\x18ftypheic"))).toEqual({ contentType: "image/heic", ext: ".heic" });
  });
  it("rejects non-images", () => {
    expect(sniffImage(b("not an image at all"))).toBeNull();
  });
  it("rejects an ftyp box that is not a HEIC brand", () => {
    // mp4/qt share the ftyp box but are not images — must not be accepted.
    expect(sniffImage(b("\x00\x00\x00\x18ftypmp42"))).toBeNull();
  });
});

describe("sanitizeFilename — path-traversal-safe, image-extension-enforced", () => {
  it("strips directory traversal, keeps basename", () => {
    expect(sanitizeFilename("../../etc/passwd", ".jpg")).toBe("passwd.jpg");
  });
  it("falls back to 'photo' for an empty name", () => {
    expect(sanitizeFilename("", ".png")).toBe("photo.png");
  });
  it("keeps a clean image filename as-is", () => {
    expect(sanitizeFilename("my photo.png", ".png")).toBe("my photo.png");
  });
  it("never lets a path separator through", () => {
    expect(sanitizeFilename("a/b/c.png", ".png")).not.toContain("/");
    expect(sanitizeFilename("a\\b\\c.png", ".png")).not.toContain("\\");
  });
});

describe("imageDimensions — header parse (replaces Pillow)", () => {
  it("reads a 1x1 PNG", () => {
    expect(imageDimensions(PNG_1x1)).toEqual({ width: 1, height: 1 });
  });
  it("reads a 1x1 GIF", () => {
    expect(imageDimensions(GIF_1x1)).toEqual({ width: 1, height: 1 });
  });
  it("returns null for formats it can't measure", () => {
    expect(imageDimensions(b("not an image"))).toBeNull();
  });
});
