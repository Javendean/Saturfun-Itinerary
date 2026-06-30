// D1 ops for photo likes (one row per device per photo) + the social-augmented list.
import type { Env } from "./types";
import type { PhotoMeta } from "./photo-store";

type LikeEnv = Pick<Env, "DB">;

export async function hasLiked(env: LikeEnv, photoId: string, deviceId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS x FROM likes WHERE photo_id = ? AND device_id = ?")
    .bind(photoId, deviceId)
    .first<{ x: number }>();
  return row !== null;
}

export async function likeCount(env: LikeEnv, photoId: string): Promise<number> {
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM likes WHERE photo_id = ?")
    .bind(photoId)
    .first<number>("n");
  return n ?? 0;
}

export async function toggleLike(
  env: LikeEnv,
  photoId: string,
  deviceId: string,
): Promise<{ liked: boolean; count: number }> {
  if (await hasLiked(env, photoId, deviceId)) {
    await env.DB.prepare("DELETE FROM likes WHERE photo_id = ? AND device_id = ?").bind(photoId, deviceId).run();
    return { liked: false, count: await likeCount(env, photoId) };
  }
  await env.DB.prepare("INSERT OR IGNORE INTO likes (photo_id, device_id, created) VALUES (?, ?, ?)")
    .bind(photoId, deviceId, Date.now() / 1000)
    .run();
  return { liked: true, count: await likeCount(env, photoId) };
}

export async function deleteLikesFor(env: LikeEnv, photoId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM likes WHERE photo_id = ?").bind(photoId).run();
}

// Photos (newest first) + like_count + whether `deviceId` liked each. One query.
export async function listPhotosWithLikes(
  env: LikeEnv,
  deviceId: string | null,
): Promise<(PhotoMeta & { like_count: number; liked: boolean })[]> {
  const { results } = await env.DB.prepare(
    `SELECT p.*,
            (SELECT COUNT(*) FROM likes l WHERE l.photo_id = p.id) AS like_count,
            (SELECT COUNT(*) FROM likes l WHERE l.photo_id = p.id AND l.device_id = ?1) AS liked_n
       FROM photos p
       ORDER BY p.uploaded DESC`,
  )
    .bind(deviceId ?? "")
    .all<PhotoMeta & { like_count: number; liked_n: number }>();
  return results.map((r) => ({ ...r, like_count: r.like_count ?? 0, liked: (r.liked_n ?? 0) > 0 }));
}
