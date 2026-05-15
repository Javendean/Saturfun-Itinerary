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
}
