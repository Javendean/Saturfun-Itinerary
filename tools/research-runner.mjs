#!/usr/bin/env node
// Autonomous research loop.
// Pops the next item from data/queue.json, invokes `claude -p` with WebSearch/WebFetch,
// validates the JSON output against the CorpusEntry shape, upserts into corpus, and
// optionally fans out adjacent candidates via enqueue_research. Batches commits every
// N entries.
//
// Usage:
//   node tools/research-runner.mjs                          # single iteration
//   node tools/research-runner.mjs --loop --interval 10m    # background mode
//   node tools/research-runner.mjs --batch-size 5           # commit cadence
//
// Critical: ANTHROPIC_API_KEY is stripped from the spawned env so this uses the
// owner's Claude Code OAuth subscription, not the API.

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verbs } from '../chat/tools.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const queuePath = path.join(repoRoot, 'data', 'queue.json');
const corpusPath = path.join(repoRoot, 'data', 'corpus', 'index.json');

const args = parseArgs(process.argv.slice(2));

async function main() {
  await fs.mkdir(path.dirname(corpusPath), { recursive: true });

  if (args.loop) {
    const intervalMs = parseInterval(args.interval || '10m');
    console.log(`[research] loop mode, interval ${args.interval || '10m'}`);
    let sinceCommit = 0;
    for (;;) {
      try { sinceCommit += await iterate(); } catch (e) { console.error('[research] iter error:', e.message); }
      if (sinceCommit >= (args.batchSize || 5)) {
        await commitBatch();
        sinceCommit = 0;
      }
      await sleep(intervalMs);
    }
  } else {
    await iterate();
    if (args.commit !== false) await commitBatch();
  }
}

async function iterate() {
  const queue = await loadJson(queuePath, []);
  if (queue.length === 0) { console.log('[research] queue empty'); return 0; }

  const next = queue.shift();
  await fs.writeFile(queuePath, JSON.stringify(queue, null, 2) + '\n');
  console.log(`[research] → ${next.topic}`);

  const kind = classifyTopic(next.topic);
  const prompt = kind === 'itinerary-candidate'
    ? await buildItineraryCandidatePrompt(next)
    : buildPrompt(next);
  const raw = await runClaude(prompt);
  const parsed = extractJson(raw);
  if (!parsed) { console.error('[research] no JSON in claude output, skipping'); return 0; }

  // Venue path: single entry. Candidate path: entries[] (multiple plans per topic).
  if (parsed.entry) await upsertCorpus(parsed.entry);
  if (Array.isArray(parsed.entries)) {
    for (const e of parsed.entries) {
      if (e && e.id && e.name) await upsertCorpus(e);
    }
    // Fan out missing-venue follow-ups for any stop.venueId not yet in corpus.
    const missing = await findMissingVenueIds(parsed.entries);
    if (missing.length) {
      await appendQueue(missing.map((id) => ({
        topic: `Discover venue: ${id} (referenced by itinerary-candidate)`,
        reason: `candidate stop references unknown venueId ${id}`,
      })));
    }
  }
  if (Array.isArray(parsed.enqueue)) await appendQueue(parsed.enqueue);

  return 1;
}

// Heuristic: "Generate ... itinerary candidate(s)" routes to the candidate prompt.
function classifyTopic(topic = '') {
  return /^\s*generate\b/i.test(topic) && /itinerary[-\s]?candidate/i.test(topic)
    ? 'itinerary-candidate'
    : 'venue';
}

function buildPrompt(item) {
  return [
    `You are Saturfun's autonomous research agent.`,
    `Task: ${item.topic}`,
    `Reason: ${item.reason || '(none)'}`,
    ``,
    `Use WebSearch and WebFetch as needed. Anchor at Industry City, Brooklyn. The user drives;`,
    `prefer venues 10-25 min from IC with weekend parking. Manhattan only if uniquely justified.`,
    ``,
    `Output a single fenced JSON block:`,
    '```json',
    `{`,
    `  "entry": {`,
    `    "id": "kebab-slug",`,
    `    "name": "Display Name",`,
    `    "desc": "one-line description (<= 120 chars)",`,
    `    "longDesc": "two-three sentences with specifics",`,
    `    "url": "official URL or Google Maps",`,
    `    "photoUrl": "real CDN photo if found, else empty string",`,
    `    "aiBackgroundUrl": "",`,
    `    "zone": "industry-city|williamsburg|red-hook|greenpoint|park-slope|brooklyn-heights|carroll-gardens|cobble-hill|dumbo|bushwick|bed-stuy|prospect-heights|crown-heights",`,
    `    "vibe": ["chill"|"curious"|"foodie"|"photo"|"active"|"romantic"],`,
    `    "dietary": ["vegetarian"|"vegan"|"halal"|"gluten-free"],`,
    `    "priceBand": "$|$$|$$$",`,
    `    "duration": "30-45 min",`,
    `    "driveFromIC": "12 min",`,
    `    "hoursWeekend": "10:00-22:00",`,
    `    "notes": "free notes with inline (source) citations",`,
    `    "sources": [{"url": "...", "accessed": "ISO8601"}],`,
    `    "promotedTo": null,`,
    `    "enriched": true,`,
    `    "needsAiBackground": false`,
    `  },`,
    `  "enqueue": [`,
    `    {"topic": "adjacent candidate name + brief why", "reason": "why it expands the corpus"}`,
    `  ]`,
    `}`,
    '```',
    ``,
    `If the topic is "Re-research existing venue: X", look up venue X and produce the entry.`,
    `If the topic is broader (e.g. "best driving-friendly coffee in zone"), pick the strongest`,
    `single venue and propose up to 3 alternatives via enqueue.`,
    ``,
    `End your response immediately after the JSON block.`,
  ].join('\n');
}

// Build a prompt that asks Claude to produce N streamlined day plans, each as a
// corpus entry with type:'itinerary-candidate' and a stops[] array. The plans
// depart from 140-59 Ash Ave, Flushing and prefer reusing existing corpus venueIds.
async function buildItineraryCandidatePrompt(item) {
  const topic = item.topic || '';
  const vibe = detectVibe(topic);
  const count = detectCount(topic) || 5;
  const corpus = await loadJson(corpusPath, []);
  // Inline a compact venue summary so the LLM can reference known ids without re-reading.
  // Cap at ~80 venues to keep prompt size sane; revisit if the corpus grows.
  const venues = corpus
    .filter((c) => c.type !== 'itinerary-candidate')
    .slice(0, 80)
    .map((c) => `- ${c.id} | ${c.name} | zone=${c.zone || '?'} | vibe=${(c.vibe || []).join(',') || '?'}`)
    .join('\n');
  const dateSlug = new Date().toISOString().slice(0, 10);

  return [
    `You are Saturfun's autonomous itinerary planner.`,
    `Task: ${topic}`,
    `Reason: ${item.reason || '(none)'}`,
    ``,
    `Origin: 140-59 Ash Ave, Flushing, NY 11355. Day: Saturday. Depart: 9:00 AM. Driver has a car.`,
    `Primary vibe to optimize: ${vibe.toUpperCase()}.`,
    `Produce ${count} DISTINCT streamlined day-plan candidates. Each must be plausible and geographically coherent.`,
    ``,
    `Existing venue corpus (prefer these venueIds; only invent new ones when no match):`,
    venues || '(empty corpus)',
    ``,
    `For each candidate, choose 5-9 stops. Estimate Saturday drive times realistically (not Google ideal).`,
    `Use WebSearch/WebFetch sparingly only to verify hours or surface a venue not in the corpus above.`,
    ``,
    `Output a single fenced JSON block. Top-level shape is {"entries":[...]}.`,
    `Each entry MUST set "type":"itinerary-candidate" and follow this shape:`,
    '```json',
    `{`,
    `  "entries": [`,
    `    {`,
    `      "id": "itin-${vibe}-${dateSlug}-001",`,
    `      "type": "itinerary-candidate",`,
    `      "name": "Short human plan name",`,
    `      "vibe": "${vibe}",`,
    `      "startTime": "9:00 AM",`,
    `      "estTotalMin": 540,`,
    `      "totalStops": 7,`,
    `      "totalDriveMin": 95,`,
    `      "zonesTouched": ["flushing","lic","manhattan-lower-east-side","industry-city","flushing"],`,
    `      "blurb": "One-paragraph human summary of the day arc.",`,
    `      "stops": [`,
    `        {"time":"9:30 AM","venueId":"existing-id-or-new-slug","driveFromPrev":8,"durationMin":45,"why":"opens early, sets the tone"}`,
    `      ],`,
    `      "notes": "free-form planning notes, traffic warnings, parking tips",`,
    `      "generatedAt": "${new Date().toISOString()}",`,
    `      "generatedBy": "research-runner",`,
    `      "enriched": true,`,
    `      "needsAiBackground": false`,
    `    }`,
    `  ],`,
    `  "enqueue": [`,
    `    {"topic": "Discover venue: <slug>", "reason": "candidate referenced a venue not in corpus"}`,
    `  ]`,
    `}`,
    '```',
    ``,
    `Rules:`,
    `- ids must be unique kebab-slugs prefixed with itin-${vibe}-${dateSlug}- and a 3-digit counter.`,
    `- First stop's driveFromPrev = drive minutes from 140-59 Ash Ave.`,
    `- totalDriveMin should equal the sum of all driveFromPrev values.`,
    `- totalStops should equal stops.length.`,
    `- estTotalMin should equal totalDriveMin + sum(durationMin) approximately.`,
    `- Prefer venueId values from the corpus list above. New venueIds are allowed but flag them in "enqueue".`,
    `- End your response immediately after the JSON block.`,
  ].join('\n');
}

// Scan candidate stops for venueIds not present in the corpus; used for fan-out.
async function findMissingVenueIds(entries) {
  const corpus = await loadJson(corpusPath, []);
  const known = new Set(corpus.map((c) => c.id));
  const missing = new Set();
  for (const e of entries) {
    for (const s of (e.stops || [])) {
      if (s && s.venueId && !known.has(s.venueId)) missing.add(s.venueId);
    }
  }
  return [...missing];
}

function detectVibe(topic) {
  const t = topic.toLowerCase();
  if (/photo|sunset|visual/.test(t)) return 'photo';
  if (/active|high[-\s]?energy|climb|axe|dance/.test(t)) return 'active';
  if (/chill|wander|relax/.test(t)) return 'chill';
  if (/foodie|food/.test(t)) return 'foodie';
  if (/romantic|date/.test(t)) return 'romantic';
  if (/mixed|geograph|neighborhood/.test(t)) return 'mixed';
  return 'mixed';
}

function detectCount(topic) {
  const m = topic.match(/generate\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const proc = spawn('claude', [
      '-p', prompt,
      '--output-format', 'text',
      '--allowedTools', 'WebSearch,WebFetch,Read',
    ], { env, cwd: repoRoot });

    let out = '', err = '';
    proc.stdout.on('data', (c) => out += c.toString());
    proc.stderr.on('data', (c) => err += c.toString());
    proc.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`claude exit ${code}: ${err.slice(0, 500)}`));
    });
  });
}

function extractJson(text) {
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  try { return JSON.parse(body); } catch {}
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(body.slice(first, last + 1)); } catch {}
  }
  return null;
}

async function upsertCorpus(entry) {
  const corpus = await loadJson(corpusPath, []);
  const state = verbs.upsert_corpus.apply({ itineraryData: [], corpus, queue: [] }, { entry });
  await fs.writeFile(corpusPath, JSON.stringify(state.corpus, null, 2) + '\n');
  console.log(`[research]   upserted ${entry.id} (corpus=${state.corpus.length})`);
}

async function appendQueue(items) {
  const queue = await loadJson(queuePath, []);
  let state = { itineraryData: [], corpus: [], queue };
  for (const it of items) {
    if (!it || !it.topic) continue;
    state = verbs.enqueue_research.apply(state, { topic: it.topic, reason: it.reason, requestedBy: 'agent' });
  }
  await fs.writeFile(queuePath, JSON.stringify(state.queue, null, 2) + '\n');
}

async function commitBatch() {
  const { spawnSync } = await import('node:child_process');
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  if (!status.stdout.trim()) return;
  spawnSync('git', ['add', 'data/'], { cwd: repoRoot });
  const r = spawnSync('git', ['commit', '-m', `[research] batch ${new Date().toISOString()}`], { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) console.error('[research] commit failed:', r.stderr);
}

async function loadJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

function parseInterval(s) {
  const m = String(s).match(/^(\d+)\s*([smh]?)$/);
  if (!m) return 600_000;
  const n = parseInt(m[1], 10);
  return n * ({ s: 1000, m: 60_000, h: 3_600_000 }[m[2] || 'm']);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseArgs(argv) {
  const out = { loop: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--loop') out.loop = true;
    else if (argv[i] === '--interval') out.interval = argv[++i];
    else if (argv[i] === '--batch-size') out.batchSize = parseInt(argv[++i], 10);
    else if (argv[i] === '--no-commit') out.commit = false;
  }
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });
