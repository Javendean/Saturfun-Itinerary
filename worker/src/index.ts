// Saturfun visitor-mode chat fallback.
//
// Endpoint: POST /api/chat
// Returns:  Server-Sent Events stream from CF Workers AI (Llama 3.3 70B fp8-fast).
//
// The wire format is the *native* Workers-AI SSE shape, passed straight through:
//
//     data: {"response":"Here are"}\n\n
//     data: {"response":" three spots"}\n\n
//     ...
//     data: {"response":null,"usage":{"prompt_tokens":159,"completion_tokens":98,"total_tokens":257}}\n\n
//     data: [DONE]\n\n
//
// Clients should:
//   1. Read the response as a stream of `data: <json>` lines.
//   2. JSON.parse each payload.
//   3. Append `payload.response` to the visible text when it's a string.
//   4. Stop on `[DONE]` (literal, not JSON).
//
// We deliberately do NOT re-wrap as `event: token / event: done` — passing the
// CF format straight through keeps the contract small and lets the visitor.js
// agent reuse standard EventSource / TextDecoder loops.

import { checkRateLimit } from "./rate-limit";
import { buildSystemPrompt } from "./system-prompt";
import { corsHeaders } from "./http";
import { handlePhotoRoute } from "./photo-routes";
import type { ChatMessage, ChatRequest, Env } from "./types";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// ---- CORS (shared in ./http) --------------------------------------------

function jsonError(status: number, message: string, env: Env, origin: string | null, extra?: HeadersInit): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(env, origin),
      ...(extra ?? {}),
    },
  });
}

// ---- Validation ---------------------------------------------------------

function validateBody(body: unknown): { ok: true; value: ChatRequest } | { ok: false; reason: string } {
  if (!body || typeof body !== "object") return { ok: false, reason: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return { ok: false, reason: "messages must be a non-empty array" };
  }
  // Cap conversation length defensively (24K-token context).
  if (b.messages.length > 32) {
    return { ok: false, reason: "too many messages (max 32)" };
  }
  const messages: ChatMessage[] = [];
  for (const m of b.messages) {
    if (!m || typeof m !== "object") return { ok: false, reason: "invalid message shape" };
    const mm = m as Record<string, unknown>;
    if (mm.role !== "user" && mm.role !== "assistant" && mm.role !== "system") {
      return { ok: false, reason: "message.role must be user|assistant|system" };
    }
    if (typeof mm.content !== "string" || mm.content.length === 0) {
      return { ok: false, reason: "message.content must be a non-empty string" };
    }
    if (mm.content.length > 4000) {
      return { ok: false, reason: "message.content too long (max 4000 chars)" };
    }
    messages.push({ role: mm.role, content: mm.content });
  }
  const context = Array.isArray(b.context) ? (b.context as ChatRequest["context"]) : undefined;
  return { ok: true, value: { messages, context } };
}

// ---- Handler ------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    // CORS preflight.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, origin) });
    }

    // Health probe — handy for status badges.
    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok", { status: 200, headers: corsHeaders(env, origin) });
    }

    // Photo wall — public upload + view, owner-gated delete (see ./photo-routes).
    // Also handles /api/profile (name store) which is part of the same feature.
    if (
      url.pathname === "/api/photos" || url.pathname.startsWith("/api/photos/") ||
      url.pathname === "/api/profile" || url.pathname.startsWith("/api/profile/") ||
      url.pathname.startsWith("/api/avatar/") ||
      url.pathname === "/api/activity" ||
      url.pathname.startsWith("/api/manga") || url.pathname.startsWith("/api/taste")
    ) {
      return handlePhotoRoute(request, env, url, origin);
    }

    if (url.pathname !== "/api/chat") {
      return jsonError(404, "not found", env, origin);
    }
    if (request.method !== "POST") {
      return jsonError(405, "method not allowed", env, origin, { Allow: "POST, OPTIONS" });
    }

    // Origin check — defense-in-depth on top of CORS (which only protects
    // browsers; non-browser clients can still hit us).
    const allowedOrigins = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim());
    if (origin && !allowedOrigins.includes(origin)) {
      return jsonError(403, "origin not allowed", env, origin);
    }

    // Rate limit by client IP.
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const max = parseInt(env.RATE_LIMIT_MAX, 10) || 10;
    const windowSeconds = parseInt(env.RATE_WINDOW_SECONDS, 10) || 60;
    if (ip !== "unknown") {
      const rl = await checkRateLimit(env.RATE_LIMIT, ip, max, windowSeconds);
      if (!rl.allowed) {
        return jsonError(429, `rate limit exceeded — retry in ${rl.resetSeconds}s`, env, origin, {
          "Retry-After": String(rl.resetSeconds),
          "X-RateLimit-Limit": String(max),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(rl.resetSeconds),
        });
      }
    }

    // Parse + validate.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonError(400, "invalid JSON body", env, origin);
    }
    const v = validateBody(body);
    if (!v.ok) return jsonError(400, v.reason, env, origin);

    // Compose final messages: our system prompt + caller's history (we drop
    // any caller-provided system messages — only the trusted prompt sets
    // the model's behavior).
    const systemPrompt = buildSystemPrompt(v.value.context);
    const finalMessages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...v.value.messages.filter((m) => m.role !== "system"),
    ];

    const maxTokens = parseInt(env.MAX_TOKENS, 10) || 800;

    // Run the model. The binding's `stream: true` returns a ReadableStream
    // whose chunks are the raw `data: {...}\n\n` SSE wire bytes — perfect
    // for piping straight to the client.
    let aiStream: ReadableStream;
    try {
      aiStream = (await env.AI.run(MODEL, {
        messages: finalMessages,
        stream: true,
        max_tokens: maxTokens,
      })) as ReadableStream;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "AI invocation failed";
      return jsonError(502, `upstream model error: ${msg}`, env, origin);
    }

    return new Response(aiStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        ...corsHeaders(env, origin),
      },
    });
  },
};
