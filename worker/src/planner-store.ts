import type { Env } from "./types";

type PEnv = Pick<Env, "DB">;

export interface Proposal {
  id: string;
  title: string;
  pitch: string;
  fits_where: string;
  neighborhood: string;
  needs_verifying: number;
  status: string;
  created: number;
}

function uuid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export async function createProposals(
  env: PEnv,
  items: { title: string; pitch: string; fits_where: string; neighborhood: string; needs_verifying: number }[],
): Promise<number> {
  if (items.length === 0) return 0;
  const now = Date.now() / 1000;
  const stmts = items.map((item) =>
    env.DB.prepare(
      "INSERT INTO proposals (id, title, pitch, fits_where, neighborhood, needs_verifying, status, created) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
    ).bind(uuid(), item.title, item.pitch, item.fits_where, item.neighborhood, item.needs_verifying, now),
  );
  await env.DB.batch(stmts);
  return items.length;
}

export async function listProposals(env: PEnv, status?: string): Promise<Proposal[]> {
  if (status !== undefined) {
    const { results } = await env.DB
      .prepare(
        "SELECT id, title, pitch, fits_where, neighborhood, needs_verifying, status, created FROM proposals WHERE status = ? ORDER BY created DESC",
      )
      .bind(status)
      .all<Proposal>();
    return results;
  }
  const { results } = await env.DB
    .prepare(
      "SELECT id, title, pitch, fits_where, neighborhood, needs_verifying, status, created FROM proposals ORDER BY created DESC",
    )
    .all<Proposal>();
  return results;
}

export async function pendingCount(env: PEnv): Promise<number> {
  return (
    (await env.DB
      .prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'")
      .first<number>("n")) ?? 0
  );
}

export async function getProposal(env: PEnv, id: string): Promise<Proposal | null> {
  return env.DB
    .prepare(
      "SELECT id, title, pitch, fits_where, neighborhood, needs_verifying, status, created FROM proposals WHERE id = ?",
    )
    .bind(id)
    .first<Proposal>();
}

export async function setFeedback(
  env: PEnv,
  id: string,
  deviceId: string,
  verdict: "approve" | "reject",
  note: string,
): Promise<void> {
  const newStatus = verdict === "approve" ? "approved" : "rejected";
  await env.DB.batch([
    env.DB.prepare("UPDATE proposals SET status = ? WHERE id = ?").bind(newStatus, id),
    env.DB.prepare(
      "INSERT INTO taste_signals (id, device_id, domain, target_ref, signal, created) VALUES (?, ?, 'itinerary', ?, ?, ?)",
    ).bind(uuid(), deviceId, id, JSON.stringify({ verdict, note }), Date.now() / 1000),
  ]);
}
