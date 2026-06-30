// Shared types for the Saturfun visitor-fallback Worker.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// One entry from the visitor's CLIP/MiniLM top-K retrieval over the corpus.
// Fields beyond `id`/`name` are best-effort — we tolerate any subset.
export interface ContextEntry {
  id?: string;
  name?: string;
  desc?: string;
  longDesc?: string;
  vibe?: string[];
  dietary?: string[];
  priceBand?: string;
  url?: string;
  // Allow forward-compatible extras without TS friction.
  [extra: string]: unknown;
}

export interface ChatRequest {
  messages: ChatMessage[];
  context?: ContextEntry[];
}

export interface Env {
  AI: Ai;
  RATE_LIMIT: KVNamespace;
  RATE_LIMIT_MAX: string;
  RATE_WINDOW_SECONDS: string;
  MAX_TOKENS: string;
  ALLOWED_ORIGINS: string;

  // ---- Photo wall ----
  PHOTOS_BUCKET: R2Bucket; // image bytes (originals + optional thumbs)
  DB: D1Database; // photo metadata
  PHOTO_MAX_MB: string; // per-file cap (default 25)
  PHOTO_MAX_TOTAL_GB: string; // total-store cap (default 9 -> 507)
  PHOTO_MAX_FILES_PER_REQUEST: string; // batch file-count cap (default 20)
  PHOTO_MAX_REQUEST_MB: string; // request body cap before buffering (default 50)
  PHOTO_RATE_LIMIT_MAX: string; // upload-only per-IP rate limit (default 60)
  PHOTO_OWNER_TOKEN?: string; // secret; gates DELETE (fails closed when unset)
}
