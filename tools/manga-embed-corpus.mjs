#!/usr/bin/env node
// Compute / refresh dual embeddings for the manga corpus.
//   data/manga-corpus/embeddings-text.json  — MiniLM L6 v2  over name + manga + techniqueNotes + whyRare + tags
//   data/manga-corpus/embeddings-clip.json  — CLIP ViT-B/32 over the panel image at imageLocalPath
//
// Both quantized int8 per-vector to match tools/embed-corpus.mjs format —
// chat/visitor.js's dequantize() reads them with no changes.
//
// Usage: node tools/manga-embed-corpus.mjs [--text-only|--image-only]

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusPath = path.join(repoRoot, 'data', 'manga-corpus', 'index.json');
const textOutPath  = path.join(repoRoot, 'data', 'manga-corpus', 'embeddings-text.json');
const clipOutPath  = path.join(repoRoot, 'data', 'manga-corpus', 'embeddings-clip.json');

const TEXT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const CLIP_MODEL = 'Xenova/clip-vit-base-patch32';
const TEXT_DIM   = 384;
const CLIP_DIM   = 512;

async function main() {
  const args = process.argv.slice(2);
  const doText  = !args.includes('--image-only');
  const doImage = !args.includes('--text-only');

  const corpus = await loadJson(corpusPath, []);
  const live = corpus.filter((p) => !p.removedAt);
  if (!live.length) { console.log('[manga-embed] corpus empty'); return; }

  const { pipeline } = await import('@xenova/transformers');

  if (doText) {
    console.log(`[manga-embed] text · ${TEXT_MODEL} · ${live.length} entries`);
    const embedder = await pipeline('feature-extraction', TEXT_MODEL);
    const out = {};
    for (const entry of live) {
      const text = embedText(entry);
      const { data } = await embedder(text, { pooling: 'mean', normalize: true });
      out[entry.id] = quantize(Array.from(data));
      process.stdout.write('.');
    }
    process.stdout.write('\n');
    await writeEmbeddings(textOutPath, {
      model: TEXT_MODEL,
      dim: TEXT_DIM,
      dtype: 'int8',
      vectors: out,
    });
    await markComputed(corpus, Object.keys(out), 'miniLM');
    console.log(`[manga-embed]   wrote ${Object.keys(out).length} text vectors to ${textOutPath}`);
  }

  if (doImage) {
    console.log(`[manga-embed] image · ${CLIP_MODEL}`);
    const clip = await pipeline('image-feature-extraction', CLIP_MODEL);
    const out = {};
    let skipped = 0;
    for (const entry of live) {
      if (!entry.imageLocalPath) { skipped++; continue; }
      const abs = path.resolve(repoRoot, entry.imageLocalPath);
      try {
        await fs.access(abs);
      } catch { skipped++; continue; }
      // The Xenova CLIP image pipeline accepts a file path or URL string.
      // It returns a tensor; mean-pooling is already inside the pipeline for this task.
      try {
        const result = await clip(abs);
        const data = result.data instanceof Float32Array ? result.data : new Float32Array(result.data);
        const normed = l2norm(Array.from(data));
        out[entry.id] = quantize(normed);
        process.stdout.write('.');
      } catch (err) {
        console.warn(`\n[manga-embed]   ${entry.id} clip error: ${err.message}`);
        skipped++;
      }
    }
    process.stdout.write('\n');
    await writeEmbeddings(clipOutPath, {
      model: CLIP_MODEL,
      dim: CLIP_DIM,
      dtype: 'int8',
      vectors: out,
    });
    await markComputed(corpus, Object.keys(out), 'clip');
    console.log(`[manga-embed]   wrote ${Object.keys(out).length} clip vectors (skipped ${skipped}) to ${clipOutPath}`);
  }

  // Persist the embeddingsComputed flags back to the corpus.
  await fs.writeFile(corpusPath, JSON.stringify(corpus, null, 2) + '\n');
}

function embedText(e) {
  return [
    e.manga,
    e.artist,
    e.chapterTitle,
    e.techniqueNotes,
    e.whyRare,
    `subjects: ${(e.subject || []).join(', ')}`,
    `mood: ${(e.mood || []).join(', ')}`,
    `style: ${e.style || ''}`,
    `composition: ${e.composition || ''}`,
    `lighting: ${e.lighting || ''}`,
    `tags: ${(e.userTags || []).join(', ')}`,
  ].filter(Boolean).join('. ');
}

function l2norm(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  return v.map((x) => x / n);
}

// Per-vector int8 quantization with stored scale. Matches tools/embed-corpus.mjs
// so chat/visitor.js's dequantize() reads it identically.
function quantize(v) {
  const max = Math.max(...v.map(Math.abs)) || 1;
  const scale = 127 / max;
  const q = v.map((x) => Math.max(-128, Math.min(127, Math.round(x * scale))));
  return { s: 1 / scale, q };
}

async function writeEmbeddings(p, payload) {
  await fs.writeFile(p, JSON.stringify({
    ...payload,
    generatedAt: new Date().toISOString(),
  }) + '\n');
}

async function markComputed(corpus, ids, kind) {
  const set = new Set(ids);
  for (const e of corpus) {
    if (!set.has(e.id)) continue;
    e.embeddingsComputed = { ...(e.embeddingsComputed || {}), [kind]: true };
  }
}

async function loadJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

main().catch((err) => { console.error(err); process.exit(1); });
