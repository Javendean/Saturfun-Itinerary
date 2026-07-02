import type { Env } from "./types";
import { sniffImage } from "./photos";
type MEnv = Pick<Env, "DB" | "PHOTOS_BUCKET">;
export interface Panel { id: string; content_type: string; created: number; }
export const ASPECTS = ["linework","composition","inking","shading","negative_space","dynamism","mood","expression","texture"];
const ASPECT_SET = new Set(ASPECTS);
function uuid() { return crypto.randomUUID().replace(/-/g, ""); }

export function isValidAspects(a: unknown): string[] {
  if (!Array.isArray(a)) return [];
  const out: string[] = [];
  for (const x of a) { if (typeof x === "string" && ASPECT_SET.has(x) && out.indexOf(x) === -1) out.push(x); if (out.length >= 9) break; }
  return out;
}

export async function savePanel(env: MEnv, deviceId: string, bytes: Uint8Array): Promise<{ id: string }> {
  const kind = sniffImage(bytes);
  if (!kind) throw new Error("not an image");
  const id = uuid();
  await env.PHOTOS_BUCKET.put(`panels/${id}`, bytes, { httpMetadata: { contentType: kind.contentType } });
  await env.DB.prepare("INSERT INTO manga_panels (id, device_id, content_type, created) VALUES (?, ?, ?, ?)")
    .bind(id, deviceId, kind.contentType, Date.now() / 1000).run();
  return { id };
}
export async function listPanels(env: MEnv, deviceId: string): Promise<Panel[]> {
  const { results } = await env.DB.prepare("SELECT id, content_type, created FROM manga_panels WHERE device_id = ? ORDER BY created DESC")
    .bind(deviceId).all<Panel>();
  return results;
}
export async function getPanelBytes(env: MEnv, id: string): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const obj = await env.PHOTOS_BUCKET.get(`panels/${id}`);
  if (!obj) return null;
  return { body: await obj.arrayBuffer(), contentType: obj.httpMetadata?.contentType || "application/octet-stream" };
}
export async function tagPanel(env: MEnv, deviceId: string, panelId: string, aspects: string[], note: string): Promise<void> {
  await env.DB.prepare("INSERT INTO taste_signals (id, device_id, domain, target_ref, signal, created) VALUES (?, ?, 'manga', ?, ?, ?)")
    .bind(uuid(), deviceId, panelId, JSON.stringify({ aspects, note }), Date.now() / 1000).run();
}
export async function getTaste(env: MEnv, deviceId: string, domain: string): Promise<any | null> {
  const row = await env.DB.prepare("SELECT data FROM taste_profiles WHERE device_id = ? AND domain = ?").bind(deviceId, domain).first<{ data: string }>();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}
export async function setTaste(env: MEnv, deviceId: string, domain: string, data: any): Promise<void> {
  await env.DB.prepare("INSERT INTO taste_profiles (device_id, domain, data, updated) VALUES (?, ?, ?, ?) ON CONFLICT(device_id, domain) DO UPDATE SET data = excluded.data, updated = excluded.updated")
    .bind(deviceId, domain, JSON.stringify(data ?? {}), Date.now() / 1000).run();
}
