import type { Env } from "./types";
type PEnv = Pick<Env, "DB">;
export interface PushSub { endpoint: string; p256dh: string; auth: string; }

export async function saveSubscription(env: PEnv, deviceId: string, sub: PushSub): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, device_id, p256dh, auth, created) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  ).bind(sub.endpoint, deviceId, sub.p256dh, sub.auth, Date.now() / 1000).run();
}
export async function deleteSubscription(env: PEnv, endpoint: string): Promise<void> {
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint).run();
}
export async function listSubscriptions(env: PEnv): Promise<PushSub[]> {
  const { results } = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all<PushSub>();
  return results;
}
export async function countSubscriptions(env: PEnv): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<number>("n")) ?? 0;
}
