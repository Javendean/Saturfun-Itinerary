// Unified recent-activity feed for the opening whirlwind. Read-only; no device_id disclosed.
import type { Env } from "./types";
type AEnv = Pick<Env, "DB">;

export async function getRecentActivity(
  env: AEnv,
  opts: { photos?: number; reactions?: number; comments?: number } = {},
) {
  const nP = opts.photos ?? 12, nR = opts.reactions ?? 24, nC = opts.comments ?? 12;
  const [ph, rx, cm] = await Promise.all([
    env.DB.prepare("SELECT id, filename, uploaded FROM photos ORDER BY uploaded DESC LIMIT ?").bind(nP).all<{ id: string; filename: string; uploaded: number }>(),
    env.DB.prepare("SELECT emoji, created FROM reactions ORDER BY created DESC LIMIT ?").bind(nR).all<{ emoji: string; created: number }>(),
    env.DB.prepare(
      `SELECT c.body, c.created, COALESCE(p.name,'Someone') AS name, p.avatar_id AS avatar_id
         FROM comments c LEFT JOIN profiles p ON p.device_id = c.device_id
        ORDER BY c.created DESC LIMIT ?`,
    ).bind(nC).all<{ body: string; created: number; name: string; avatar_id: string | null }>(),
  ]);
  const photos = ph.results;
  const reactions = rx.results;
  const comments = cm.results.map((c) => ({ name: c.name, body: c.body, avatar_url: c.avatar_id ? `/api/avatar/${c.avatar_id}` : null, created: c.created }));
  const latest = Math.max(0, photos[0]?.uploaded ?? 0, reactions[0]?.created ?? 0, comments[0]?.created ?? 0);
  return { photos, reactions, comments, latest };
}
