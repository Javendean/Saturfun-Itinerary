#!/usr/bin/env node
// Import vetted Brooklyn venues from a content-research markdown catalog into
// data/corpus/index.json. The catalog is a markdown file with one table per
// checkpoint; each row holds name | neighborhood | zone | vibe | dietary | $ |
// duration | drive | url | why | notes.
//
// Idempotent: re-running merges into existing entries via verbs.upsert_corpus.
// Pure local data transformation — no claude / WebSearch calls.
//
// Usage:
//   node tools/import-content-research.mjs                    # uses default path
//   node tools/import-content-research.mjs --path <md-path>   # custom catalog
//   node tools/import-content-research.mjs --no-prune-queue   # skip queue prune
//   node tools/import-content-research.mjs --dry-run          # parse + report only

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verbs } from '../chat/tools.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusPath = path.join(repoRoot, 'data', 'corpus', 'index.json');
const queuePath = path.join(repoRoot, 'data', 'queue.json');
const defaultCatalogPath = 'C:\\tmp\\saturfun-content-research.md';

const args = parseArgs(process.argv.slice(2));

async function main() {
  const catalogPath = args.path || defaultCatalogPath;
  const md = await fs.readFile(catalogPath, 'utf8');
  const accessedAt = new Date().toISOString();

  const { rows, failures } = parseCatalog(md);
  console.log(`[import] parsed ${rows.length} venue rows from ${catalogPath}`);
  if (failures.length) {
    console.warn(`[import] ${failures.length} row(s) failed to parse:`);
    for (const f of failures) console.warn(`  - ${f.section}: ${f.reason} :: ${f.line.slice(0, 80)}`);
  }

  const entries = rows
    .map((r) => normalizeEntry(r, catalogPath, accessedAt))
    .filter(Boolean);
  console.log(`[import] normalized ${entries.length} CorpusEntry objects`);

  if (args.dryRun) {
    console.log('[import] --dry-run, skipping writes');
    return;
  }

  await fs.mkdir(path.dirname(corpusPath), { recursive: true });
  const corpusBefore = await loadJson(corpusPath, []);
  let state = { itineraryData: [], corpus: corpusBefore, queue: [] };
  let imported = 0;
  for (const entry of entries) {
    state = verbs.upsert_corpus.apply(state, { entry });
    imported += 1;
  }
  await writeJson(corpusPath, state.corpus);
  console.log(`[import] wrote ${state.corpus.length} entries to ${corpusPath} (+${imported} upserts)`);

  if (args.prune !== false) {
    const result = await pruneQueue(entries);
    console.log(`[import] pruned ${result.removed} queue items, ${result.remaining} remain`);
  }
}

function parseCatalog(md) {
  const rows = [];
  const failures = [];
  const lines = md.split(/\r?\n/);
  let section = null;
  let inTable = false;
  let headerSeen = false;

  for (const raw of lines) {
    const line = raw.trim();
    const headerMatch = raw.match(/^##\s+(.+?)\s*$/);
    if (headerMatch) {
      section = headerMatch[1];
      inTable = false;
      headerSeen = false;
      continue;
    }
    if (!section || !line.startsWith('|')) {
      inTable = false;
      headerSeen = false;
      continue;
    }
    // Inside a table.
    if (!headerSeen) {
      // First | line is the header row, then a divider, then data.
      const cells = splitRow(line);
      if (cells[0] && cells[0].toLowerCase() === 'name') {
        headerSeen = true;
        inTable = true;
      }
      continue;
    }
    // Skip the divider row (cells of dashes).
    const cells = splitRow(line);
    if (cells.every((c) => /^[-:\s]*$/.test(c))) continue;
    if (cells.length < 11) {
      failures.push({ section, reason: `expected 11 cells, got ${cells.length}`, line });
      continue;
    }
    const [name, neighborhood, zone, vibe, dietary, price, duration, drive, url, why, notes] = cells;
    if (!name) {
      failures.push({ section, reason: 'empty name', line });
      continue;
    }
    rows.push({ section, name, neighborhood, zone, vibe, dietary, price, duration, drive, url, why, notes });
  }

  return { rows, failures };
}

function splitRow(line) {
  // Strip leading/trailing pipes then split. Cells may contain commas but not pipes.
  const trimmed = line.replace(/^\|/, '').replace(/\|\s*$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

function normalizeEntry(row, catalogPath, accessedAt) {
  const id = slugify(`${row.name}-${row.neighborhood || row.zone || ''}`);
  if (!id) return null;
  const vibe = parseList(row.vibe);
  const dietary = parseList(row.dietary);
  const priceBand = normalizePriceBand(row.price);
  const driveFromIC = row.drive || '';
  const url = (row.url || '').trim();
  const desc = oneLineDesc(row.why);
  const longDesc = (row.why || '').trim();

  return {
    id,
    name: row.name,
    desc,
    longDesc,
    url,
    photoUrl: '',
    aiBackgroundUrl: '',
    zone: row.zone || '',
    vibe,
    dietary,
    priceBand,
    duration: row.duration || '',
    driveFromIC,
    hoursWeekend: extractHours(row.notes),
    notes: row.notes || '',
    sources: [{ url: catalogPath, accessed: accessedAt }],
    promotedTo: null,
    enriched: true,
    needsPhoto: true,
    needsAiBackground: true,
    discoveryAngle: 'content-research-import',
    sourceCheckpoint: row.section,
    neighborhood: row.neighborhood || '',
  };
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function parseList(s) {
  if (!s) return [];
  return s
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x && x !== 'any');
}

function normalizePriceBand(p) {
  if (!p) return null;
  const cleaned = p.replace(/[^$]/g, '');
  if (cleaned === '$' || cleaned === '$$' || cleaned === '$$$' || cleaned === '$$$$') return cleaned;
  if (/^free$/i.test(p.trim())) return '$';
  return null;
}

function oneLineDesc(why) {
  if (!why) return '';
  // Take the first clause up to ~120 chars: split on ; or — or .
  const first = why.split(/[;—.]/)[0].trim();
  if (first.length <= 120) return first;
  return first.slice(0, 117) + '...';
}

function extractHours(notes) {
  if (!notes) return null;
  // Try common patterns: "Sat 5pm-12am", "10am-midnight", "open 6am-11pm", "12-6"
  const m = notes.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM)?\s*[-–]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm|AM|PM|midnight|MIDNIGHT)?)\b/);
  return m ? m[1] : null;
}

const REREARCH_PREFIX = 'Re-research existing venue: ';

async function pruneQueue(entries) {
  const queue = await loadJson(queuePath, []);
  const importedNames = new Set(entries.map((e) => normalizeName(e.name)));
  const kept = [];
  let removed = 0;
  for (const item of queue) {
    if (typeof item.topic === 'string' && item.topic.startsWith(REREARCH_PREFIX)) {
      const venueName = item.topic.slice(REREARCH_PREFIX.length);
      if (importedNames.has(normalizeName(venueName))) {
        removed += 1;
        continue;
      }
    }
    kept.push(item);
  }
  if (removed > 0) await writeJson(queuePath, kept);
  return { removed, remaining: kept.length };
}

function normalizeName(s) {
  return String(s)
    .toLowerCase()
    // strip parenthetical context like "(lunch alt)" or "(en-route on Atlantic)"
    .replace(/\([^)]*\)/g, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    // common abbreviations the catalog may spell out
    .replace(/\bbar-?b-?que\b/g, 'bbq')
    .replace(/[^a-z0-9]+/g, '');
}

async function loadJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

async function writeJson(p, value) {
  await fs.writeFile(p, JSON.stringify(value, null, 2) + '\n');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--path') out.path = argv[++i];
    else if (argv[i] === '--no-prune-queue') out.prune = false;
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });
