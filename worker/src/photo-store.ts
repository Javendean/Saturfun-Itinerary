// Storage layer for the photo wall: image bytes in R2, metadata in D1.
// Ported from the kit's save_upload (photos.py) + the 5 DB methods (§6/§3).
// Bytes and metadata are kept strictly separate — D1 never holds image data.
import type { Env } from "./types";
import { sniffImage, sanitizeFilename, imageDimensions } from "./photos";

// Only the bindings/vars the store touches — lets tests pass any env shape.
type PhotoEnv = Pick<
  Env,
  "PHOTOS_BUCKET" | "DB" | "PHOTO_MAX_MB" | "PHOTO_MAX_TOTAL_GB" | "PHOTO_MAX_FILES_PER_REQUEST" | "PHOTO_MAX_REQUEST_MB"
>;

/** Public photo row — `stored_name` is the R2 key and is NEVER sent to clients. */
export interface PhotoMeta {
  id: string;
  filename: string;
  stored_name: string;
  content_type: string;
  size: number;
  width: number | null;
  height: number | null;
  has_thumb: number; // 0 | 1
  uploaded: number; // epoch seconds (float)
}

/** Carries an HTTP status so the route can map validation failures to 400/413. */
export class PhotoError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PhotoError";
    this.status = status;
  }
}

// R2 key layout: originals under originals/, generated thumbs under thumbs/.
const originalKey = (storedName: string) => `originals/${storedName}`;
const thumbKey = (photoId: string) => `thumbs/${photoId}.jpg`;

export function maxPhotoBytes(env: PhotoEnv): number {
  return (parseInt(env.PHOTO_MAX_MB, 10) || 25) * 1024 * 1024;
}
export function maxTotalPhotoBytes(env: PhotoEnv): number {
  return (parseInt(env.PHOTO_MAX_TOTAL_GB, 10) || 3) * 1024 * 1024 * 1024;
}
export function maxFilesPerRequest(env: PhotoEnv): number {
  return parseInt(env.PHOTO_MAX_FILES_PER_REQUEST, 10) || 20;
}
export function maxRequestBytes(env: PhotoEnv): number {
  return (parseInt(env.PHOTO_MAX_REQUEST_MB, 10) || 100) * 1024 * 1024;
}

/**
 * Validate (magic bytes + size), store the original in R2, and return metadata.
 * Does NOT write to D1 — the route does that after the total-store check, mirroring
 * the kit so a partial batch can report both buckets.
 */
export async function saveUpload(
  env: PhotoEnv,
  raw: Uint8Array,
  originalName: string,
  maxBytes?: number,
): Promise<PhotoMeta> {
  if (!raw || raw.length === 0) throw new PhotoError("empty file");
  const limit = maxBytes ?? maxPhotoBytes(env);
  if (raw.length > limit) {
    throw new PhotoError(`file too large (max ${Math.floor(limit / (1024 * 1024))} MB)`, 413);
  }
  const sniffed = sniffImage(raw.subarray(0, 16));
  if (!sniffed) throw new PhotoError("not a recognised image (jpg, png, gif, webp, bmp, heic)");

  const id = crypto.randomUUID().replace(/-/g, ""); // uuid4().hex equivalent (32 hex)
  const storedName = `${id}${sniffed.ext}`;
  await env.PHOTOS_BUCKET.put(originalKey(storedName), raw, {
    httpMetadata: { contentType: sniffed.contentType },
  });
  const dims = imageDimensions(raw);

  return {
    id,
    filename: sanitizeFilename(originalName, sniffed.ext),
    stored_name: storedName,
    content_type: sniffed.contentType,
    size: raw.length,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    has_thumb: 0, // no server-side thumbs on the edge; thumb endpoint falls back to original
    uploaded: Date.now() / 1000,
  };
}

// ---- byte ops (R2) -------------------------------------------------------

export function getOriginal(env: PhotoEnv, storedName: string): Promise<R2ObjectBody | null> {
  return env.PHOTOS_BUCKET.get(originalKey(storedName));
}
export function getThumb(env: PhotoEnv, photoId: string): Promise<R2ObjectBody | null> {
  return env.PHOTOS_BUCKET.get(thumbKey(photoId));
}
export async function deleteFiles(env: PhotoEnv, storedName: string, photoId: string): Promise<void> {
  await env.PHOTOS_BUCKET.delete([originalKey(storedName), thumbKey(photoId)]);
}

// ---- metadata ops (D1) — the kit's 5 methods -----------------------------

export async function addPhoto(env: PhotoEnv, m: PhotoMeta): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO photos (id, filename, stored_name, content_type, size, width, height, has_thumb, uploaded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(m.id, m.filename, m.stored_name, m.content_type, m.size, m.width, m.height, m.has_thumb, m.uploaded)
    .run();
}

export async function listPhotos(env: PhotoEnv): Promise<PhotoMeta[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM photos ORDER BY uploaded DESC",
  ).all<PhotoMeta>();
  return results;
}

export async function getPhoto(env: PhotoEnv, id: string): Promise<PhotoMeta | null> {
  return env.DB.prepare("SELECT * FROM photos WHERE id = ?").bind(id).first<PhotoMeta>();
}

export async function deletePhoto(env: PhotoEnv, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
}

export async function totalPhotoBytes(env: PhotoEnv): Promise<number> {
  const total = await env.DB.prepare(
    "SELECT COALESCE(SUM(size), 0) AS total FROM photos",
  ).first<number>("total");
  return total ?? 0;
}
