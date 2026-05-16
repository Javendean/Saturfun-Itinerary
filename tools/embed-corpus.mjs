#!/usr/bin/env node
// Compute / refresh data/corpus/embeddings.json.
//
// Each entry is embedded by concatenating its name + desc + longDesc + tags. Vectors
// are 384-dim float32 from sentence-transformers/all-MiniLM-L6-v2. We quantize to
// int8 with a per-vector scale so the on-disk file stays under ~200 KB at 60 venues.
//
// Usage: node tools/embed-corpus.mjs

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusPath = path.join(repoRoot, 'data', 'corpus', 'index.json');
const outPath = path.join(repoRoot, 'data', 'corpus', 'embeddings.json');

async function main() {
  const corpus = JSON.parse(await fs.readFile(corpusPath, 'utf8'));
  if (!corpus.length) { console.log('[embed] corpus empty, nothing to do'); return; }

  const { pipeline } = await import('@xenova/transformers');
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  const out = {};
  for (const entry of corpus) {
    const text = embedText(entry);
    const { data } = await embedder(text, { pooling: 'mean', normalize: true });
    out[entry.id] = quantize(Array.from(data));
    process.stdout.write('.');
  }
  process.stdout.write('\n');

  await fs.writeFile(outPath, JSON.stringify({
    model: 'Xenova/all-MiniLM-L6-v2',
    dim: 384,
    dtype: 'int8',
    generatedAt: new Date().toISOString(),
    vectors: out,
  }, null, 0) + '\n');

  console.log(`[embed] wrote ${Object.keys(out).length} vectors to ${outPath}`);
}

// Coerce to array of strings — harvester sometimes writes vibe/dietary as a
// single string instead of an array. Defensive so one bad entry doesn't crash
// the whole embedding pass.
const toArr = (v) => Array.isArray(v) ? v : (typeof v === 'string' && v ? [v] : []);

// Map machine zone slugs to the human phrases real queries use ("what's at
// Industry City?", "vegetarian dinner in Williamsburg"). MiniLM weights opening
// tokens heavily, so we hoist these to the front of the embed text — this is
// the single biggest lever for zone-targeted recall.
const ZONE_PHRASES = {
  'industry-city': 'Industry City Sunset Park Brooklyn',
  'sunset-park': 'Sunset Park Brooklyn',
  'williamsburg': 'Williamsburg Brooklyn',
  'park-slope': 'Park Slope Brooklyn',
  'carroll-gardens': 'Carroll Gardens Brooklyn',
  'brooklyn-heights': 'Brooklyn Heights Brooklyn',
  'gowanus': 'Gowanus Brooklyn',
  'red-hook': 'Red Hook Brooklyn',
  'fort-greene': 'Fort Greene Brooklyn',
  'dumbo': 'Dumbo Brooklyn',
  'bushwick': 'Bushwick Brooklyn',
  'greenpoint': 'Greenpoint Brooklyn',
  'cobble-hill': 'Cobble Hill Brooklyn',
  'prospect-heights': 'Prospect Heights Brooklyn',
  'crown-heights': 'Crown Heights Brooklyn',
  'flushing': 'Flushing Queens',
};

function zonePhrase(slug) {
  if (!slug) return '';
  if (ZONE_PHRASES[slug]) return ZONE_PHRASES[slug];
  // Generic fallback: turn "some-zone-slug" into "Some Zone Slug".
  return String(slug).split('-').map((w) => w ? w[0].toUpperCase() + w.slice(1) : '').join(' ').trim();
}

function embedText(e) {
  const zone = zonePhrase(e.zone);
  const neighborhood = e.neighborhood || zone;
  // Lead the text with location signal (MiniLM is order-sensitive). Then a
  // synthetic sentence with the name + neighborhood so generic queries like
  // "restaurants at Industry City" can match short-desc entries like
  // "Han Dynasty / Sip & Co" whose name omits the neighborhood.
  const lead = [
    neighborhood && zone ? `${neighborhood}, ${zone}` : (neighborhood || zone),
    e.name ? `${e.name} in ${neighborhood || zone || 'Brooklyn'}` : '',
  ].filter(Boolean).join('. ');
  const body = [
    e.name, e.desc, e.longDesc,
    `neighborhood: ${neighborhood || ''}`,
    `zone: ${zone || ''}`,
    `vibe: ${toArr(e.vibe).join(', ')}`,
    `dietary: ${toArr(e.dietary).join(', ')}`,
    `price: ${e.priceBand || ''}`,
    e.duration ? `duration: ${e.duration}` : '',
    e.hoursWeekend ? `hours: ${e.hoursWeekend}` : '',
    e.driveFromIC ? `from Industry City: ${e.driveFromIC}` : '',
    e.parkingNotes || '',
    e.sourceCheckpoint || '',
    e.discoveryAngle || '',
    e.notes || '',
  ].filter(Boolean).join('. ');
  return lead ? `${lead}. ${body}` : body;
}

// Per-vector int8 quantization with stored scale. Loader divides by scale to reconstruct.
function quantize(v) {
  const max = Math.max(...v.map(Math.abs)) || 1;
  const scale = 127 / max;
  const q = v.map((x) => Math.max(-128, Math.min(127, Math.round(x * scale))));
  return { s: 1 / scale, q };
}

main().catch((e) => { console.error(e); process.exit(1); });
