#!/usr/bin/env node
// Diagnose: how well does the current embedding retrieve Industry City venues
// for queries that mention Industry City? Prints top-K for a handful of probes.
//
// Usage: node tools/test-retrieval.mjs
//        node tools/test-retrieval.mjs "your custom query"

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusPath = path.join(repoRoot, 'data', 'corpus', 'index.json');
const embPath    = path.join(repoRoot, 'data', 'corpus', 'embeddings.json');

const QUERIES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'what restaurants are at Industry City',
      'where can I get coffee near Industry City',
      'what activities are at Industry City',
      'vegetarian dinner in Williamsburg',
      'tell me about Industry City',
    ];

function dequantize({ s, q }, dim) {
  const out = new Float32Array(dim);
  for (let i = 0; i < dim && i < q.length; i++) out[i] = q[i] * s;
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const x = a[i], y = b[i]; dot += x * y; na += x * x; nb += y * y; }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

async function main() {
  const corpus = JSON.parse(await fs.readFile(corpusPath, 'utf8'));
  const emb    = JSON.parse(await fs.readFile(embPath, 'utf8'));
  const dim = emb.dim || 384;

  const embById = {};
  for (const [id, payload] of Object.entries(emb.vectors || {})) {
    embById[id] = dequantize(payload, dim);
  }

  console.log(`[corpus] ${corpus.length} entries, ${Object.keys(embById).length} embeddings, dim=${dim}`);
  const icCount = corpus.filter(e => /industry.city/i.test(e.zone || '')).length;
  console.log(`[corpus] Industry City entries: ${icCount}`);

  const { pipeline } = await import('@xenova/transformers');
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  for (const q of QUERIES) {
    const { data } = await embedder(q, { pooling: 'mean', normalize: true });
    const qvec = data instanceof Float32Array ? data : new Float32Array(data);

    const scored = [];
    for (const entry of corpus) {
      const v = embById[entry.id];
      if (!v) continue;
      scored.push({ entry, score: cosine(qvec, v) });
    }
    scored.sort((a, b) => b.score - a.score);
    const top10 = scored.slice(0, 10);
    const top5 = scored.slice(0, 5);

    const icInTop10 = top10.filter(r => /industry.city/i.test(r.entry.zone || '')).length;
    const icInTop5  = top5.filter(r => /industry.city/i.test(r.entry.zone || '')).length;

    console.log(`\n=== Query: "${q}" ===`);
    console.log(`    Industry-City in top-5: ${icInTop5}/5  ·  in top-10: ${icInTop10}/10`);
    for (const [i, r] of top10.entries()) {
      console.log(`    ${String(i + 1).padStart(2)}. ${r.score.toFixed(4)}  [${r.entry.zone || '?'}]  ${r.entry.name}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
