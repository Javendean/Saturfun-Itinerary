#!/usr/bin/env node
// Autonomous manga-panel harvester.
// Pops the next item from data/manga-queue.json, dispatches per discoveryAngle,
// invokes the Claude Agent SDK (Opus 4.7 1M, OAuth-billed) with vision when
// useful, parses the fenced JSON result, upserts into manga-corpus, fans out
// adjacent candidates. Foreground-only, owner-attended; anti-flag rate limits
// enforced. Batched commits every N entries.
//
// Critical: ANTHROPIC_API_KEY is removed from env per-call so OAuth wins.
//
// Usage:
//   node tools/manga-harvest-runner.mjs                              # one item
//   node tools/manga-harvest-runner.mjs --loop --interval 45s
//   node tools/manga-harvest-runner.mjs --loop --daily-cap 500 --max-hours 6
//   node tools/manga-harvest-runner.mjs --loop --angle reverse-image
//   node tools/manga-harvest-runner.mjs --no-commit                  # dry run

import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verbs } from '../chat/manga-tools.js';

const repoRoot   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const queuePath  = path.join(repoRoot, 'data', 'manga-queue.json');
const corpusDir  = path.join(repoRoot, 'data', 'manga-corpus');
const corpusPath = path.join(corpusDir, 'index.json');

const MODEL = 'claude-opus-4-7[1m]';
const TRACEMOE_URL = 'https://api.trace.moe/search?cutBorders';

// Anti-flag knobs (defaults — flagged "generous-but-conservative" given Max
// account quota; raise via CLI for power-runs).
const DEFAULT_INTERVAL_MS = 45_000;     // ≥30s required, 45s default
const DEFAULT_DAILY_CAP   = 500;
const DEFAULT_MAX_HOURS   = 6;
const DEFAULT_BATCH_SIZE  = 5;

const args = parseArgs(process.argv.slice(2));

// Pre-flight: refuse to run from a non-tty (cron/daemon scenario). The whole
// point of attended runs is the human is around to spot weird outputs early.
if (args.loop && !process.stdout.isTTY) {
  console.error('[manga-harvest] refuses to loop without a TTY. Run from a foreground shell.');
  process.exit(2);
}

if (process.env.ANTHROPIC_API_KEY) {
  console.warn('[manga-harvest] WARN: ANTHROPIC_API_KEY in env; will be stripped per-call.');
}
if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.warn('[manga-harvest] WARN: CLAUDE_CODE_OAUTH_TOKEN missing. Run `claude setup-token`.');
}

let querySdk = null;
async function loadSdk() {
  if (querySdk !== null) return querySdk;
  try {
    const mod = await import('@anthropic-ai/claude-agent-sdk');
    querySdk = mod.query;
  } catch (err) {
    console.error('[manga-harvest] FATAL: @anthropic-ai/claude-agent-sdk not installed.');
    console.error('[manga-harvest] Run: npm install @anthropic-ai/claude-agent-sdk');
    throw err;
  }
  return querySdk;
}

const angleHandlers = {
  'reverse-image':     handleReverseImage,
  'artist-deep-dive':  handleArtistDeepDive,
  'fan-archive':       handleFanArchive,
  'splash-transition': handleSplashTransition,
};

async function main() {
  await fs.mkdir(corpusDir, { recursive: true });

  if (!args.loop) {
    await iterate();
    if (args.commit !== false) await commitBatch();
    return;
  }

  const intervalMs = parseInterval(args.interval || `${DEFAULT_INTERVAL_MS}ms`);
  const enforcedInterval = Math.max(intervalMs, 30_000);
  const dailyCap = args.dailyCap ?? DEFAULT_DAILY_CAP;
  const maxHoursMs = (args.maxHours ?? DEFAULT_MAX_HOURS) * 3_600_000;
  const batchSize = args.batchSize ?? DEFAULT_BATCH_SIZE;

  const startedAt = Date.now();
  let calls = 0;
  let sinceCommit = 0;

  console.log(`[manga-harvest] loop interval=${enforcedInterval}ms cap=${dailyCap} maxHours=${args.maxHours ?? DEFAULT_MAX_HOURS}`);

  for (;;) {
    if (Date.now() - startedAt > maxHoursMs) {
      console.log('[manga-harvest] session cap reached; exiting');
      break;
    }
    if (calls >= dailyCap) {
      console.log('[manga-harvest] daily cap reached; exiting');
      break;
    }

    try {
      const did = await iterate();
      if (did) { calls++; sinceCommit += did; }
    } catch (err) {
      console.error('[manga-harvest] iter error:', err.message);
    }

    if (sinceCommit >= batchSize) {
      await commitBatch();
      sinceCommit = 0;
    }

    await sleep(enforcedInterval);
  }

  if (sinceCommit > 0) await commitBatch();
}

async function iterate() {
  const queue = await loadJson(queuePath, []);
  if (!queue.length) { console.log('[manga-harvest] queue empty'); return 0; }

  // Optional --angle filter pops the first matching item rather than blindly shifting.
  let idx = 0;
  if (args.angle) {
    idx = queue.findIndex((q) => q.discoveryAngle === args.angle);
    if (idx < 0) { console.log(`[manga-harvest] no items for angle=${args.angle}`); return 0; }
  }

  const [item] = queue.splice(idx, 1);
  await fs.writeFile(queuePath, JSON.stringify(queue, null, 2) + '\n');
  console.log(`[manga-harvest] → [${item.discoveryAngle}] ${item.topic}`);

  const handler = angleHandlers[item.discoveryAngle];
  if (!handler) { console.error('[manga-harvest] unknown angle:', item.discoveryAngle); return 0; }

  const result = await handler(item);
  if (!result) return 0;

  if (Array.isArray(result.entries)) {
    for (const e of result.entries) await upsertOne(e);
  }
  if (result.entry) await upsertOne(result.entry);
  if (Array.isArray(result.enqueue)) await appendQueue(result.enqueue);

  return 1;
}

// --- Per-angle handlers --------------------------------------------------

async function handleReverseImage(item) {
  const seedPath = item.input?.seedPath;
  if (!seedPath) { console.error('[manga-harvest] reverse-image missing seedPath'); return null; }
  const absSeed = path.resolve(repoRoot, seedPath);

  let traceMoe = null;
  try {
    traceMoe = await traceMoeLookup(absSeed);
  } catch (err) {
    console.warn(`[manga-harvest] tracemoe lookup failed: ${err.message} — continuing without it`);
  }

  const prompt = [
    `You are a manga-panel research curator helping an artist build a 10-minute drawing reference archive.`,
    `Below is a seed panel image. ${traceMoe?.summary ? 'TraceMoe identified it as: ' + traceMoe.summary : 'TraceMoe did not return a confident match.'}`,
    ``,
    `Task: identify this panel (manga, chapter, page, artist) and propose 5 nearby panels worth archiving — same volume or adjacent volumes — that share visual energy or technique. For each panel produce a full PanelEntry. Emit one fenced JSON block.`,
    ``,
    jsonShapeHint(),
  ].join('\n');

  return await callAgent(prompt, { imagePath: absSeed });
}

async function handleArtistDeepDive(item) {
  const prompt = [
    `You are a manga-craft historian helping an artist build a 10-minute drawing reference archive.`,
    `Topic: ${item.topic}`,
    `Reason: ${item.reason || '(none)'}`,
    ``,
    `Task: list 8-12 specific rare or canonical-but-instructive panels matching the topic. Use WebSearch / WebFetch as needed to verify chapter and page numbers. Prioritize tankobon-only panels, splash pages, and craft-rich frames over story-progression panels.`,
    ``,
    jsonShapeHint(),
  ].join('\n');

  return await callAgent(prompt);
}

async function handleFanArchive(item) {
  const prompt = [
    `You are a manga-curation researcher helping an artist build a 10-minute drawing reference archive.`,
    `Topic: ${item.topic}`,
    `Reason: ${item.reason || '(none)'}`,
    ``,
    `Task: use WebFetch to pull the named source (or its closest discoverable equivalent), extract panel references with manga + chapter + page where available, and pull out any commentary on why the community considers them noteworthy. Aim for 6-15 panels. Skip panels that are story spoilers without craft value.`,
    ``,
    jsonShapeHint(),
  ].join('\n');

  return await callAgent(prompt);
}

async function handleSplashTransition(item) {
  const prompt = [
    `You are a manga-craft historian helping an artist build a 10-minute drawing reference archive.`,
    `Topic: ${item.topic}`,
    `Reason: ${item.reason || '(none)'}`,
    ``,
    `Task: identify the strongest 8-12 splash pages, double-spreads, or wordless transition pages matching the topic. Use WebSearch / WebFetch to verify chapter and page. Emphasize composition, perspective, and lighting in techniqueNotes.`,
    ``,
    jsonShapeHint(),
  ].join('\n');

  return await callAgent(prompt);
}

// --- Agent SDK invocation ------------------------------------------------

async function callAgent(prompt, { imagePath } = {}) {
  const sdkQuery = await loadSdk();

  const content = [{ type: 'text', text: prompt }];
  if (imagePath) {
    const buf = await fs.readFile(imagePath);
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: guessMedia(imagePath),
        data: buf.toString('base64'),
      },
    });
  }

  async function* userMessages() {
    yield { type: 'user', message: { role: 'user', content } };
  }

  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  let assembled = '';
  try {
    for await (const event of sdkQuery({
      prompt: userMessages(),
      options: {
        model: MODEL,
        allowedTools: imagePath ? ['Read'] : ['WebSearch', 'WebFetch', 'Read'],
        cwd: repoRoot,
        maxTurns: 8,
      },
    })) {
      // The SDK emits typed events. We collect text + the final result string.
      if (event.type === 'assistant' && event.message?.content) {
        for (const c of event.message.content) {
          if (c.type === 'text' && c.text) assembled += c.text;
        }
      } else if (event.type === 'result' && typeof event.result === 'string') {
        assembled = assembled || event.result;
      }
    }
  } finally {
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  }

  const parsed = extractJson(assembled);
  if (!parsed) {
    console.error('[manga-harvest] no JSON in agent output (first 200 chars):', assembled.slice(0, 200));
    return null;
  }
  return parsed;
}

// --- TraceMoe -----------------------------------------------------------

// POST a binary image body. TraceMoe accepts multipart and raw — raw is simpler.
// Response shape (verified once vs api.trace.moe docs Apr 2026):
//   { result: [ { anilist: {...} | <id>, episode, from, to, similarity, image, video } ] }
// We're loose: tolerate either an anilist-id integer or an embedded title object.
async function traceMoeLookup(absImagePath) {
  const buf = await fs.readFile(absImagePath);
  const res = await fetch(TRACEMOE_URL, {
    method: 'POST',
    headers: { 'Content-Type': guessMedia(absImagePath) },
    body: buf,
  });
  if (!res.ok) throw new Error(`tracemoe http ${res.status}`);
  const json = await res.json();
  const top = json?.result?.[0];
  if (!top) return { summary: '', raw: json };
  const title =
    top.anilist?.title?.romaji ||
    top.anilist?.title?.english ||
    top.filename ||
    `anilist-${top.anilist?.id ?? top.anilist ?? 'unknown'}`;
  const summary = `${title} (similarity ${(top.similarity * 100).toFixed(1)}%, ep ${top.episode ?? '?'})`;
  return { summary, raw: top };
}

// --- Persistence helpers (mirror the itinerary research-runner) ---------

function extractJson(text) {
  if (!text) return null;
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

async function upsertOne(entry) {
  if (!entry || !entry.id) {
    console.warn('[manga-harvest] skipping entry without id:', entry?.manga || '?');
    return;
  }
  const corpus = await loadJson(corpusPath, []);
  const state = verbs.upsert_corpus.apply(
    { panels: corpus, collections: [], queue: [] },
    { entry }
  );
  await fs.writeFile(corpusPath, JSON.stringify(state.panels, null, 2) + '\n');
  console.log(`[manga-harvest]   upserted ${entry.id} (corpus=${state.panels.length})`);
}

async function appendQueue(items) {
  const queue = await loadJson(queuePath, []);
  let state = { panels: [], collections: [], queue };
  for (const it of items) {
    if (!it?.topic) continue;
    state = verbs.enqueue_research.apply(state, {
      topic: it.topic,
      discoveryAngle: it.discoveryAngle || 'artist-deep-dive',
      reason: it.reason || '',
      requestedBy: 'agent',
      input: it.input,
    });
  }
  await fs.writeFile(queuePath, JSON.stringify(state.queue, null, 2) + '\n');
}

async function commitBatch() {
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  if (!status.stdout?.trim()) return;
  spawnSync('git', ['add', 'data/manga-corpus/', 'data/manga-queue.json'], { cwd: repoRoot });
  const r = spawnSync('git', [
    'commit', '-m', `[manga-harvest] batch ${new Date().toISOString()}`,
  ], { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) console.error('[manga-harvest] commit failed:', r.stderr);
}

async function loadJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

function jsonShapeHint() {
  return [
    `Output a single fenced JSON block of this exact shape (omit fields you don't know rather than guessing):`,
    '```json',
    `{`,
    `  "entries": [`,
    `    {`,
    `      "id": "kebab-slug-with-manga-and-chapter",`,
    `      "manga": "Berserk",`,
    `      "chapter": 86,`,
    `      "chapterTitle": "Eclipse",`,
    `      "page": 12,`,
    `      "panelIndex": 1,`,
    `      "isSplash": true,`,
    `      "isDoubleSpread": false,`,
    `      "artist": "Kentaro Miura",`,
    `      "imageUrl": "(optional canonical URL)",`,
    `      "subject": ["character", "supernatural"],`,
    `      "characters": ["Griffith"],`,
    `      "complexity": 5,`,
    `      "style": "hatched",`,
    `      "composition": "splash",`,
    `      "lighting": "high-contrast",`,
    `      "perspective": "low-angle",`,
    `      "mood": ["dread", "awe"],`,
    `      "techniqueNotes": "1-2 sentences on what an artist would learn copying this panel",`,
    `      "whyRare": "why this is worth archiving (tankobon-only, deleted scene, peak craft, etc.)",`,
    `      "discoveryAngle": "artist-deep-dive",`,
    `      "sources": [{"type": "websearch", "url": "...", "accessed": "ISO8601"}]`,
    `    }`,
    `  ],`,
    `  "enqueue": [`,
    `    {"topic": "follow-up topic", "discoveryAngle": "artist-deep-dive", "reason": "why"}`,
    `  ]`,
    `}`,
    '```',
    `End your response immediately after the JSON block.`,
  ].join('\n');
}

function guessMedia(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function parseInterval(s) {
  const m = String(s).match(/^(\d+)\s*(ms|s|m|h)?$/);
  if (!m) return DEFAULT_INTERVAL_MS;
  const n = parseInt(m[1], 10);
  const unit = m[2] || 'ms';
  return n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseArgs(argv) {
  const out = { loop: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--loop') out.loop = true;
    else if (argv[i] === '--interval') out.interval = argv[++i];
    else if (argv[i] === '--batch-size') out.batchSize = parseInt(argv[++i], 10);
    else if (argv[i] === '--daily-cap') out.dailyCap = parseInt(argv[++i], 10);
    else if (argv[i] === '--max-hours') out.maxHours = parseFloat(argv[++i]);
    else if (argv[i] === '--angle') out.angle = argv[++i];
    else if (argv[i] === '--no-commit') out.commit = false;
  }
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });
