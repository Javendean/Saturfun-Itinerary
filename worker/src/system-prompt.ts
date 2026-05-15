// Builds the Llama system prompt by inlining the corpus context entries the
// visitor's browser already retrieved (CLIP/MiniLM top-K). The model never
// sees Saturfun's full corpus — only the K snippets the client decided are
// relevant for this turn.

import type { ContextEntry } from "./types";

const SYSTEM_BASE = `You are Saturfun, a Brooklyn-itinerary assistant.

Rules:
- Answer using ONLY the venue facts provided in CONTEXT. If CONTEXT is empty or doesn't cover the question, say so briefly and suggest browsing the Saturfun map instead.
- Reply in 2-4 short sentences. No headers, no bullet lists, no markdown tables.
- When you mention a venue, weave its name in naturally; never invent details (hours, prices, addresses) that aren't in CONTEXT.
- Stay in Brooklyn. Politely deflect off-topic requests.`;

// Cap how much of each entry we inline — defends against pathological input
// from a malicious client trying to blow past the 24K context window.
const MAX_DESC_CHARS = 600;
const MAX_LONG_CHARS = 1200;
const MAX_ENTRIES = 8;

function clip(s: unknown, n: number): string {
  if (typeof s !== "string") return "";
  return s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
}

function tagList(v: unknown): string {
  if (!Array.isArray(v)) return "";
  return v
    .filter((x) => typeof x === "string")
    .slice(0, 8)
    .join(", ");
}

function renderEntry(e: ContextEntry, i: number): string {
  const lines: string[] = [`[${i + 1}] ${e.name ?? "(unnamed)"}`];
  const desc = clip(e.longDesc, MAX_LONG_CHARS) || clip(e.desc, MAX_DESC_CHARS);
  if (desc) lines.push(desc);
  const vibe = tagList(e.vibe);
  const dietary = tagList(e.dietary);
  if (vibe) lines.push(`vibe: ${vibe}`);
  if (dietary) lines.push(`dietary: ${dietary}`);
  if (e.priceBand) lines.push(`price: ${e.priceBand}`);
  if (e.url) lines.push(`url: ${e.url}`);
  return lines.join("\n");
}

export function buildSystemPrompt(context: ContextEntry[] | undefined): string {
  const entries = Array.isArray(context) ? context.slice(0, MAX_ENTRIES) : [];
  if (entries.length === 0) {
    return `${SYSTEM_BASE}\n\nCONTEXT: (none provided)`;
  }
  const body = entries.map(renderEntry).join("\n\n");
  return `${SYSTEM_BASE}\n\nCONTEXT:\n${body}`;
}
