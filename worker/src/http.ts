// Shared CORS + origin helpers for every route (chat + photos).
import type { Env } from "./types";

type OriginEnv = Pick<Env, "ALLOWED_ORIGINS">;

function allowedList(env: OriginEnv): string[] {
  return env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
}

/** True if no Origin (non-browser / same-origin) or the Origin is allow-listed. */
export function isAllowedOrigin(env: OriginEnv, origin: string | null): boolean {
  if (!origin) return true;
  return allowedList(env).includes(origin);
}

/**
 * CORS headers. Methods + headers are broadened to cover the photo wall
 * (GET image fetches, DELETE with the owner token) on top of chat's POST.
 */
export function corsHeaders(env: OriginEnv, origin: string | null): HeadersInit {
  const allowed = allowedList(env);
  const allow = origin && allowed.includes(origin) ? origin : (allowed[0] ?? "*");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Owner-Token",
    "Access-Control-Expose-Headers": "Retry-After", // so the frontend can read 429 backoff
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
