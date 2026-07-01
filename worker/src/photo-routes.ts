// HTTP routes for the photo wall — the kit's §1 contract / §7 routes, ported to
// the Worker. Public upload + view; DELETE is owner-gated (X-Owner-Token).
//
// Error bodies use FastAPI's `{ detail }` shape so the kit's frontend + UAT
// (which read `.detail`) port unchanged.
import type { Env } from "./types";
import { corsHeaders, isAllowedOrigin } from "./http";
import { checkRateLimit } from "./rate-limit";
import * as store from "./photo-store";
import { PhotoError, type PhotoMeta } from "./photo-store";
import * as reactions from "./reaction-store";
import * as comments from "./comment-store";
import * as activity from "./activity-store";

const IMMUTABLE = "public, max-age=31536000, immutable"; // ids are content-stable
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

function publicPhoto(p: PhotoMeta & { reactions?: import("./reaction-store").Reaction[] }) {
  // stored_name is the R2 key — it is NEVER exposed to clients.
  return {
    id: p.id,
    filename: p.filename,
    content_type: p.content_type,
    size: p.size,
    width: p.width,
    height: p.height,
    has_thumb: Boolean(p.has_thumb),
    uploaded: p.uploaded,
    ...(p.reactions !== undefined ? { reactions: p.reactions } : {}),
  };
}

function detail(status: number, message: string, env: Env, origin: string | null, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify({ detail: message }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env, origin), ...extra },
  });
}

function jsonOk(obj: unknown, env: Env, origin: string | null, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env, origin) },
  });
}

// Constant-time string compare (length is allowed to leak — standard).
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function isOwner(request: Request, env: Env): boolean {
  const token = env.PHOTO_OWNER_TOKEN;
  if (!token) return false; // fail closed: delete disabled until the secret is set
  return timingSafeEqual(request.headers.get("X-Owner-Token") ?? "", token);
}

const ITEM_RE = /^\/api\/photos\/([^/]+)(?:\/(raw|thumb|download|react|comments))?(?:\/([^/]+))?$/;

export async function handlePhotoRoute(
  request: Request,
  env: Env,
  url: URL,
  origin: string | null,
): Promise<Response> {
  try {
    // Origin defense-in-depth (browsers only; non-browser clients send no Origin).
    if (origin && !isAllowedOrigin(env, origin)) {
      return detail(403, "origin not allowed", env, origin);
    }

    const path = url.pathname;
    const method = request.method;

    // Activity feed — /api/activity
    if (path === "/api/activity") {
      if (method !== "GET") return detail(405, "method not allowed", env, origin, { Allow: "GET, OPTIONS" });
      return jsonOk(await activity.getRecentActivity(env), env, origin);
    }

    // Avatar — /api/profile/avatar (upload) and /api/avatar/{avatar_id} (serve)
    if (path === "/api/profile/avatar") {
      if (method !== "POST") return detail(405, "method not allowed", env, origin, { Allow: "POST, OPTIONS" });
      const cl = parseInt(request.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(cl) && cl > AVATAR_MAX_BYTES + 1024) return detail(413, "avatar too large", env, origin);
      let form: FormData;
      try { form = await request.formData(); } catch { return detail(400, "expected multipart/form-data", env, origin); }
      const device = String(form.get("device_id") || "").trim();
      const file = form.get("avatar");
      if (!device) return detail(400, "device_id required", env, origin);
      if (!(file instanceof File)) return detail(400, "avatar file required", env, origin);
      if (file.size > AVATAR_MAX_BYTES) return detail(413, "avatar too large", env, origin);
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        const { avatar_id } = await comments.setAvatar(env, device, bytes);
        return jsonOk({ avatar_url: `/api/avatar/${avatar_id}` }, env, origin);
      } catch { return detail(400, "not an image", env, origin); }
    }
    { const am = path.match(/^\/api\/avatar\/([^/]+)$/);
      if (am) {
        if (method !== "GET") return detail(405, "method not allowed", env, origin, { Allow: "GET, OPTIONS" });
        const got = await comments.getAvatarBytes(env, decodeURIComponent(am[1]));
        if (!got) return detail(404, "not found", env, origin);
        return new Response(got.body, { headers: { "Content-Type": got.contentType, "Cache-Control": "public, max-age=60", "X-Content-Type-Options": "nosniff", ...corsHeaders(env, origin) } });
      } }

    // Profile — /api/profile and /api/profile/{device_id}
    if (path === "/api/profile") {
      if (method === "PUT") {
        let body: Record<string, unknown>; try { body = await request.json(); } catch { body = {}; }
        const device = typeof body.device_id === "string" ? body.device_id.trim() : "";
        const name = comments.sanitizeName(body.name);
        if (!device) return detail(400, "device_id required", env, origin);
        if (!name) return detail(400, "name required", env, origin);
        await comments.setName(env, device, name);
        return jsonOk({ name }, env, origin);
      }
      return detail(405, "method not allowed", env, origin, { Allow: "PUT, OPTIONS" });
    }
    { const pm = path.match(/^\/api\/profile\/([^/]+)$/);
      if (pm) {
        if (method !== "GET") return detail(405, "method not allowed", env, origin, { Allow: "GET, OPTIONS" });
        const name = await comments.getName(env, decodeURIComponent(pm[1]));
        return name ? jsonOk({ name }, env, origin) : detail(404, "no profile", env, origin);
      } }

    // Collection — /api/photos
    if (path === "/api/photos") {
      if (method === "GET") {
        const device = url.searchParams.get("device");
        const withRx = await reactions.listPhotosWithReactions(env, device);
        const counts = await comments.commentCounts(env);
        const photos = withRx.map((p) => ({ ...publicPhoto(p), comment_count: counts[p.id] ?? 0 }));
        return jsonOk({ photos }, env, origin);
      }
      if (method === "POST") return await uploadPhotos(request, env, origin);
      return detail(405, "method not allowed", env, origin, { Allow: "GET, POST, OPTIONS" });
    }

    // Item — /api/photos/{id}[/raw|/thumb|/download|/react|/comments[/{cid}]]
    const m = path.match(ITEM_RE);
    if (!m) return detail(404, "not found", env, origin);
    let id: string;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return detail(404, "not found", env, origin); // malformed %-escape -> contract 404
    }
    const action = m[2];
    const commentId = m[3];

    if (commentId && action !== "comments") return detail(404, "not found", env, origin);

    if (!action) {
      if (method === "DELETE") return await deletePhoto(request, env, origin, id);
      return detail(405, "method not allowed", env, origin, { Allow: "DELETE, OPTIONS" });
    }
    if (action === "react") {
      if (method !== "POST") return detail(405, "method not allowed", env, origin, { Allow: "POST, OPTIONS" });
      let body: Record<string, unknown>;
      try { body = await request.json(); } catch { body = {}; }
      const device = typeof body.device_id === "string" ? body.device_id.trim() : "";
      const emoji = typeof body.emoji === "string" ? body.emoji : "";
      if (!device) return detail(400, "device_id required", env, origin);
      if (!reactions.isValidEmoji(emoji)) return detail(400, "invalid emoji", env, origin);
      const summary = await reactions.toggleReaction(env, id, device, emoji);
      return jsonOk({ reactions: summary }, env, origin);
    }
    if (action === "comments") {
      if (method === "GET") { const device = url.searchParams.get("device"); return jsonOk({ comments: await comments.listComments(env, id, device) }, env, origin); }
      if (method === "POST") {
        if (commentId) return detail(404, "not found", env, origin);
        let body: Record<string, unknown>; try { body = await request.json(); } catch { body = {}; }
        const device = typeof body.device_id === "string" ? body.device_id.trim() : "";
        const text = comments.sanitizeBody(body.body);
        if (!device) return detail(400, "device_id required", env, origin);
        if (!text) return detail(400, "comment required", env, origin);
        const ip = request.headers.get("cf-connecting-ip") || "anon";
        const limited = await checkRateLimit(env.RATE_LIMIT, ip, Number(env.PHOTO_RATE_LIMIT_MAX) || 60, 60, "rlc");
        if (!limited.allowed) return detail(429, "slow down", env, origin, { "Retry-After": String(limited.resetSeconds) });
        const c = await comments.addComment(env, id, device, text);
        return jsonOk({ id: c.id, body: c.body, created: c.created, name: c.name }, env, origin, 201);
      }
      if (method === "DELETE") {
        if (!commentId) return detail(404, "not found", env, origin);
        const row = await comments.getComment(env, commentId);
        if (!row) return detail(404, "not found", env, origin);
        let body: Record<string, unknown>; try { body = await request.json(); } catch { body = {}; }
        const device = typeof body.device_id === "string" ? body.device_id.trim() : "";
        if (!isOwner(request, env) && device !== row.device_id) return detail(403, "not allowed", env, origin);
        await comments.deleteComment(env, commentId);
        return jsonOk({ ok: true }, env, origin);
      }
      return detail(405, "method not allowed", env, origin, { Allow: "GET, POST, DELETE, OPTIONS" });
    }
    if (method !== "GET") return detail(405, "method not allowed", env, origin, { Allow: "GET, OPTIONS" });

    const p = await store.getPhoto(env, id);
    if (!p) return detail(404, "photo not found", env, origin);

    if (action === "thumb") return await serveThumb(env, origin, p);
    return await serveOriginal(env, origin, p, action === "download");
  } catch {
    // Last-resort guard: any unexpected throw becomes a contract-shaped 500 with CORS.
    return detail(500, "internal error", env, origin);
  }
}

async function uploadPhotos(request: Request, env: Env, origin: string | null): Promise<Response> {
  // Reject oversize bodies BEFORE buffering, to protect the 128 MB isolate.
  const cl = parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(cl) && cl > store.maxRequestBytes(env)) {
    return detail(413, "request too large", env, origin);
  }

  // Upload has its own (higher) per-IP limit + counter ("rlu") so bulk batches
  // don't collide with the chat limiter. Skipped when IP is unknown.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (ip !== "unknown") {
    const max = parseInt(env.PHOTO_RATE_LIMIT_MAX, 10) || 60;
    const win = parseInt(env.RATE_WINDOW_SECONDS, 10) || 60;
    const rl = await checkRateLimit(env.RATE_LIMIT, ip, max, win, "rlu");
    if (!rl.allowed) {
      return detail(429, `rate limit exceeded — retry in ${rl.resetSeconds}s`, env, origin, {
        "Retry-After": String(rl.resetSeconds),
      });
    }
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return detail(400, "expected multipart/form-data", env, origin);
  }
  const files = form.getAll("files").filter((f): f is File => f instanceof File);

  // Bound the batch so one request can't amplify into thousands of R2/D1 writes.
  const maxFiles = store.maxFilesPerRequest(env);
  if (files.length > maxFiles) {
    return detail(413, `too many files (max ${maxFiles} per request)`, env, origin);
  }

  const perFileCap = store.maxPhotoBytes(env);
  const created: ReturnType<typeof publicPhoto>[] = [];
  const errors: { filename: string; error: string }[] = [];
  let firstStatus = 400;
  let used = await store.totalPhotoBytes(env);
  const totalCap = store.maxTotalPhotoBytes(env);

  for (const f of files) {
    // Cheap f.size guards BEFORE materializing bytes (avoids a second in-isolate copy).
    if (f.size > perFileCap) {
      if (errors.length === 0) firstStatus = 413;
      errors.push({ filename: f.name, error: `file too large (max ${parseInt(env.PHOTO_MAX_MB, 10) || 25} MB)` });
      continue;
    }
    if (used + f.size > totalCap) {
      if (errors.length === 0) firstStatus = 507;
      errors.push({ filename: f.name, error: "photo storage is full" });
      continue;
    }
    try {
      const raw = new Uint8Array(await f.arrayBuffer());
      const meta = await store.saveUpload(env, raw, f.name || "photo");
      try {
        await store.addPhoto(env, meta);
      } catch {
        // D1 insert failed AFTER the R2 put — delete the orphaned bytes so they
        // can't accumulate uncounted against the storage cap.
        await store.deleteFiles(env, meta.stored_name, meta.id).catch(() => {});
        throw new PhotoError("could not record upload", 500);
      }
      used += meta.size;
      created.push(publicPhoto(meta));
    } catch (e) {
      const pe = e instanceof PhotoError ? e : new PhotoError("upload failed", 400);
      if (errors.length === 0) firstStatus = pe.status;
      errors.push({ filename: f.name, error: pe.message });
    }
  }

  // 4xx/507 only when NOTHING succeeded; a partial batch is 200 with both buckets.
  if (created.length === 0 && errors.length > 0) {
    return detail(firstStatus, errors[0].error, env, origin);
  }
  return jsonOk({ photos: created, errors }, env, origin);
}

async function serveOriginal(
  env: Env,
  origin: string | null,
  p: PhotoMeta,
  asAttachment: boolean,
): Promise<Response> {
  const obj = await store.getOriginal(env, p.stored_name);
  if (!obj) return detail(404, "photo file missing", env, origin);

  const headers = new Headers(corsHeaders(env, origin) as Record<string, string>);
  headers.set("Content-Type", p.content_type);
  headers.set("Content-Length", String(obj.size));
  if (asAttachment) {
    const ascii = p.filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    headers.set(
      "Content-Disposition",
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(p.filename)}`,
    );
  } else {
    headers.set("Cache-Control", IMMUTABLE);
  }
  return new Response(obj.body, { status: 200, headers });
}

async function serveThumb(env: Env, origin: string | null, p: PhotoMeta): Promise<Response> {
  if (p.has_thumb) {
    const t = await store.getThumb(env, p.id);
    if (t) {
      const headers = new Headers(corsHeaders(env, origin) as Record<string, string>);
      headers.set("Content-Type", "image/jpeg");
      headers.set("Content-Length", String(t.size));
      headers.set("Cache-Control", IMMUTABLE);
      return new Response(t.body, { status: 200, headers });
    }
  }
  // No thumb (the edge can't generate them) — fall back to the original.
  return serveOriginal(env, origin, p, false);
}

async function deletePhoto(request: Request, env: Env, origin: string | null, id: string): Promise<Response> {
  // Owner check FIRST, so a non-owner can't probe which ids exist.
  if (!isOwner(request, env)) return detail(403, "forbidden — owner token required", env, origin);
  const p = await store.getPhoto(env, id);
  if (!p) return detail(404, "photo not found", env, origin);
  await store.deleteFiles(env, p.stored_name, p.id);
  await reactions.deleteReactionsFor(env, p.id);
  await comments.deleteCommentsFor(env, p.id);
  await store.deletePhoto(env, p.id);
  return jsonOk({ ok: true }, env, origin);
}
