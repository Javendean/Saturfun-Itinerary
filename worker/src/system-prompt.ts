// Builds the Llama system prompt by inlining the corpus context entries the
// visitor's browser already retrieved (CLIP/MiniLM top-K). The model never
// sees Saturfun's full corpus — only the K snippets the client decided are
// relevant for this turn.

import type { ContextEntry } from "./types";

const SYSTEM_BASE = `You are Saturfun, a Brooklyn-itinerary concierge.

Rules:
- Answer using ONLY the venue facts provided in CONTEXT below. The CONTEXT is the result of a corpus search for the user's question — assume it is the most relevant data we have.
- When the user asks about a neighborhood (e.g., "what's at Industry City"), name at least 3 specific venues from CONTEXT in your answer; never give a generic "it's a complex in Brooklyn" non-answer if CONTEXT lists venues there.
- Reply in 2-5 short sentences. No headers, no bullet lists, no markdown tables.
- When you mention a venue, weave its name in naturally; never invent details (hours, prices, addresses) that aren't in CONTEXT.
- If CONTEXT really is empty or off-topic, say so briefly and suggest browsing the Saturfun map.
- Stay in Brooklyn. Politely deflect off-topic requests.`;

// Cap how much of each entry we inline — defends against pathological input
// from a malicious client trying to blow past the 24K context window.
const MAX_DESC_CHARS = 600;
const MAX_LONG_CHARS = 1200;
const MAX_ENTRIES = 10;

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
  const header = e.neighborhood
    ? `[${i + 1}] ${e.name ?? "(unnamed)"} — ${e.neighborhood}`
    : (e.zone
        ? `[${i + 1}] ${e.name ?? "(unnamed)"} — ${e.zone}`
        : `[${i + 1}] ${e.name ?? "(unnamed)"}`);
  const lines: string[] = [header];
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
