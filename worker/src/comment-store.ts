// Comments + a name-only profile. Comments join profiles for the current display name.
import type { Env } from "./types";
type CEnv = Pick<Env, "DB">;
export interface CommentRow { id: string; body: string; created: number; name: string; device_id: string; }

export function sanitizeName(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (t.length < 1) return null;
  return t.slice(0, 40);
}
export function sanitizeBody(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (t.length < 1) return null;
  return t.slice(0, 500);
}

export async function setName(env: CEnv, deviceId: string, name: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO profiles (device_id, name, updated) VALUES (?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, updated = excluded.updated`,
  ).bind(deviceId, name, Date.now() / 1000).run();
}
export async function getName(env: CEnv, deviceId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT name FROM profiles WHERE device_id = ?").bind(deviceId).first<{ name: string }>();
  return row ? row.name : null;
}

function uuid(): string { return crypto.randomUUID().replace(/-/g, ""); }

export async function addComment(env: CEnv, photoId: string, deviceId: string, body: string): Promise<CommentRow> {
  const id = uuid();
  const created = Date.now() / 1000;
  await env.DB.prepare("INSERT INTO comments (id, photo_id, device_id, body, created) VALUES (?, ?, ?, ?, ?)")
    .bind(id, photoId, deviceId, body, created).run();
  const name = (await getName(env, deviceId)) ?? "Someone";
  return { id, body, created, name, device_id: deviceId };
}

export async function listComments(env: CEnv, photoId: string): Promise<CommentRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.body, c.created, c.device_id, COALESCE(p.name, 'Someone') AS name
       FROM comments c LEFT JOIN profiles p ON p.device_id = c.device_id
      WHERE c.photo_id = ? ORDER BY c.created ASC, c.id ASC`,
  ).bind(photoId).all<CommentRow>();
  return results;
}

export async function getComment(env: CEnv, id: string): Promise<{ device_id: string } | null> {
  return await env.DB.prepare("SELECT device_id FROM comments WHERE id = ?").bind(id).first<{ device_id: string }>();
}
export async function deleteComment(env: CEnv, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
}
export async function deleteCommentsFor(env: CEnv, photoId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM comments WHERE photo_id = ?").bind(photoId).run();
}

export async function commentCounts(env: CEnv): Promise<Record<string, number>> {
  const { results } = await env.DB.prepare("SELECT photo_id, COUNT(*) AS n FROM comments GROUP BY photo_id")
    .all<{ photo_id: string; n: number }>();
  const out: Record<string, number> = {};
  for (const r of results) out[r.photo_id] = r.n;
  return out;
}
