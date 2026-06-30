// Emoji reactions: one row per (photo, device, emoji). A device may stack many emojis.
import type { Env } from "./types";
import type { PhotoMeta } from "./photo-store";

type RxEnv = Pick<Env, "DB">;
export interface Reaction { emoji: string; count: number; mine: boolean; }

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
// Accept a short emoji string (1–8 code points, contains a pictographic, no ASCII letters).
// Rejects plain text, injected markup, and overlong blobs. Output is still escaped on render.
export function isValidEmoji(s: unknown): boolean {
  if (typeof s !== "string") return false;
  const cps = Array.from(s);
  if (cps.length < 1 || cps.length > 8) return false;
  if (/[A-Za-z]/.test(s)) return false;
  if (/\s/.test(s)) return false;
  return PICTOGRAPHIC.test(s);
}

export async function reactionsFor(env: RxEnv, photoId: string, deviceId: string | null): Promise<Reaction[]> {
  const { results } = await env.DB.prepare(
    `SELECT emoji, COUNT(*) AS count, MAX(CASE WHEN device_id = ?2 THEN 1 ELSE 0 END) AS mine
       FROM reactions WHERE photo_id = ?1
       GROUP BY emoji ORDER BY count DESC, emoji ASC`,
  ).bind(photoId, deviceId ?? "").all<{ emoji: string; count: number; mine: number }>();
  return results.map((r) => ({ emoji: r.emoji, count: r.count, mine: r.mine > 0 }));
}

export async function toggleReaction(env: RxEnv, photoId: string, deviceId: string, emoji: string): Promise<Reaction[]> {
  const existing = await env.DB.prepare(
    "SELECT 1 AS x FROM reactions WHERE photo_id = ? AND device_id = ? AND emoji = ?",
  ).bind(photoId, deviceId, emoji).first<{ x: number }>();
  if (existing) {
    await env.DB.prepare("DELETE FROM reactions WHERE photo_id = ? AND device_id = ? AND emoji = ?")
      .bind(photoId, deviceId, emoji).run();
  } else {
    await env.DB.prepare("INSERT OR IGNORE INTO reactions (photo_id, device_id, emoji, created) VALUES (?, ?, ?, ?)")
      .bind(photoId, deviceId, emoji, Date.now() / 1000).run();
  }
  return reactionsFor(env, photoId, deviceId);
}

export async function deleteReactionsFor(env: RxEnv, photoId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM reactions WHERE photo_id = ?").bind(photoId).run();
}

export async function listPhotosWithReactions(
  env: RxEnv,
  deviceId: string | null,
): Promise<(PhotoMeta & { reactions: Reaction[] })[]> {
  const { results: photos } = await env.DB.prepare("SELECT * FROM photos ORDER BY uploaded DESC").all<PhotoMeta>();
  const { results: rx } = await env.DB.prepare(
    `SELECT photo_id, emoji, COUNT(*) AS count, MAX(CASE WHEN device_id = ?1 THEN 1 ELSE 0 END) AS mine
       FROM reactions GROUP BY photo_id, emoji ORDER BY count DESC, emoji ASC`,
  ).bind(deviceId ?? "").all<{ photo_id: string; emoji: string; count: number; mine: number }>();
  const byPhoto = new Map<string, Reaction[]>();
  for (const r of rx) {
    const arr = byPhoto.get(r.photo_id) ?? [];
    arr.push({ emoji: r.emoji, count: r.count, mine: r.mine > 0 });
    byPhoto.set(r.photo_id, arr);
  }
  return photos.map((p) => ({ ...p, reactions: byPhoto.get(p.id) ?? [] }));
}
