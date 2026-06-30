// Photo-wall pure logic: magic-byte sniffing, filename sanitization, dimension
// parsing. Ported from the transplant kit's photos.py. NO Cloudflare deps here —
// this is the security boundary, kept pure + unit-tested.
//
// The endpoint is public, so uploads are validated by LEADING MAGIC BYTES only —
// never the client-supplied Content-Type or filename extension.

// HEIC/HEIF brands that may follow an `ftyp` box. mp4/qt also use `ftyp` but are
// not images, so the brand must be in this allow-list.
const HEIC_BRANDS = new Set([
  "heic", "heix", "hevc", "heim", "heis", "hevm", "hevs", "mif1", "msf1", "heif",
]);

const IMAGE_EXTS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif",
]);

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function matchAt(bytes: Uint8Array, offset: number, pattern: number[]): boolean {
  if (offset + pattern.length > bytes.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (bytes[offset + i] !== pattern[i]) return false;
  }
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, len: number): string {
  if (offset + len > bytes.length) return "";
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}

export interface Sniffed {
  contentType: string;
  ext: string;
}

/** Detect an image type from leading bytes, or null if not a recognised image. */
export function sniffImage(head: Uint8Array): Sniffed | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { contentType: "image/jpeg", ext: ".jpg" };
  }
  if (matchAt(head, 0, PNG_SIG)) {
    return { contentType: "image/png", ext: ".png" };
  }
  const sig6 = asciiAt(head, 0, 6);
  if (sig6 === "GIF87a" || sig6 === "GIF89a") {
    return { contentType: "image/gif", ext: ".gif" };
  }
  if (asciiAt(head, 0, 4) === "RIFF" && asciiAt(head, 8, 4) === "WEBP") {
    return { contentType: "image/webp", ext: ".webp" };
  }
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) {
    return { contentType: "image/bmp", ext: ".bmp" };
  }
  if (asciiAt(head, 4, 4) === "ftyp" && HEIC_BRANDS.has(asciiAt(head, 8, 4))) {
    return { contentType: "image/heic", ext: ".heic" };
  }
  return null;
}

const ILLEGAL_FILENAME_CHARS = new Set(["\\", "/", ":", "*", "?", '"', "<", ">", "|"]);

/**
 * Make a client filename safe to echo back: strip directories (both / and \),
 * remove non-printable + illegal chars, cap length, and guarantee an image
 * extension (appending the sniffed `fallbackExt` when the name lacks one).
 */
export function sanitizeFilename(name: string, fallbackExt: string): string {
  // Basename: part after the last separator, covering POSIX and Windows paths.
  const base = (name || "").split(/[\\/]/).pop() ?? "";
  let cleaned = "";
  for (const ch of base) {
    const code = ch.codePointAt(0)!;
    const printable = code >= 0x20 && code !== 0x7f;
    if (printable && !ILLEGAL_FILENAME_CHARS.has(ch)) cleaned += ch;
  }
  cleaned = cleaned.trim().slice(0, 120);
  if (!cleaned) cleaned = "photo";
  const dot = cleaned.lastIndexOf(".");
  const suffix = dot >= 0 ? cleaned.slice(dot).toLowerCase() : "";
  if (!IMAGE_EXTS.has(suffix)) cleaned += fallbackExt;
  return cleaned;
}

export interface Dimensions {
  width: number;
  height: number;
}

/**
 * Read pixel dimensions from image header bytes (replaces Pillow on the edge).
 * Handles PNG + GIF (enough for the contract's width/height); returns null for
 * formats we don't measure here (JPEG/WEBP/HEIC/BMP) — the contract allows null.
 */
export function imageDimensions(bytes: Uint8Array): Dimensions | null {
  // PNG: 8-byte signature, then IHDR chunk — width @16, height @20 (big-endian).
  if (matchAt(bytes, 0, PNG_SIG) && bytes.length >= 24) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16, false), height: dv.getUint32(20, false) };
  }
  // GIF: logical screen descriptor — width @6, height @8 (little-endian u16).
  const sig6 = asciiAt(bytes, 0, 6);
  if ((sig6 === "GIF87a" || sig6 === "GIF89a") && bytes.length >= 10) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  return null;
}
