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

function embedText(e) {
  return [
    e.name, e.desc, e.longDesc,
    `zone: ${e.zone || ''}`,
    `vibe: ${(e.vibe || []).join(', ')}`,
    `dietary: ${(e.dietary || []).join(', ')}`,
    `price: ${e.priceBand || ''}`,
    e.notes || '',
  ].filter(Boolean).join('. ');
}

// Per-vector int8 quantization with stored scale. Loader divides by scale to reconstruct.
function quantize(v) {
  const max = Math.max(...v.map(Math.abs)) || 1;
  const scale = 127 / max;
  const q = v.map((x) => Math.max(-128, Math.min(127, Math.round(x * scale))));
  return { s: 1 / scale, q };
}

main().catch((e) => { console.error(e); process.exit(1); });
