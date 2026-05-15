#!/usr/bin/env node
// Manga panel image downloader.
// Bridges harvester (writes corpus metadata + imageUrl) and embedder (needs
// local image files for CLIP). For each PanelEntry lacking imageLocalPath
// but bearing an imageUrl, fetch the image, validate it's actually an image,
// write to images/panels/<id>.<ext>, optionally generate a thumbnail under
// images/panels/.thumbs/<id>.webp, and patch the corpus via verbs.update_panel.
//
// Idempotent — re-runs are no-ops for entries already on disk (unless --force).
// Polite — 1.5s sleep between fetches, identifying User-Agent.
// Robust — single bad URL never kills the loop.
//
// Usage:
//   node tools/manga-image-downloader.mjs              # one-shot, full pass
//   node tools/manga-image-downloader.mjs --limit 50   # cap downloads per run
//   node tools/manga-image-downloader.mjs --dry-run    # report only, no writes
//   node tools/manga-image-downloader.mjs --force      # re-download even if local exists

import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verbs } from '../chat/manga-tools.js';

const repoRoot   = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusPath = path.join(repoRoot, 'data', 'manga-corpus', 'index.json');
const panelsDir  = path.join(repoRoot, 'images', 'panels');
const thumbsDir  = path.join(panelsDir, '.thumbs');

const USER_AGENT = 'Saturfun-Manga-Harvester/0.1 (personal-archive)';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const SLEEP_BETWEEN_MS = 1500;
const COMMIT_BATCH_SIZE = 10;
const THUMB_MAX_EDGE = 400;

const EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg':  '.jpg',
  'image/png':  '.png',
  'image/webp': '.webp',
  'image/gif':  '.gif',
  'image/avif': '.avif',
};

const args = parseArgs(process.argv.slice(2));

// Try to load sharp lazily — it's a heavy native dep we don't want to require.
// If unavailable, we silently skip thumbnail generation.
let sharpModule = null;
let sharpAttempted = false;
async function loadSharp() {
  if (sharpAttempted) return sharpModule;
  sharpAttempted = true;
  try {
    const mod = await import('sharp');
    sharpModule = mod.default || mod;
    console.log('[manga-download] sharp available — generating thumbnails');
  } catch {
    console.warn('[manga-download] sharp not installed — skipping thumbnails (full-res still saved)');
    sharpModule = null;
  }
  return sharpModule;
}

async function main() {
  const corpus = await loadJson(corpusPath, []);
  if (!Array.isArray(corpus) || corpus.length === 0) {
    console.log('[manga-download] corpus empty or missing; nothing to do');
    return;
  }

  await fs.mkdir(panelsDir, { recursive: true });
  if (!args.dryRun) await fs.mkdir(thumbsDir, { recursive: true });

  const stats = {
    total: corpus.length,
    downloaded: 0,
    alreadyLocal: 0,
    skippedNoUrl: 0,
    errored: 0,
    skippedRemoved: 0,
  };

  let sinceCommit = 0;

  for (const entry of corpus) {
    if (entry.removedAt) { stats.skippedRemoved++; continue; }

    // Already has a local image and isn't forced — skip.
    if (entry.imageLocalPath && !args.force) {
      const abs = path.resolve(repoRoot, entry.imageLocalPath);
      try {
        await fs.access(abs);
        stats.alreadyLocal++;
        continue;
      } catch {
        // File on disk vanished — fall through and re-fetch.
        console.warn(`[manga-download]   ${entry.id} imageLocalPath missing on disk; re-downloading`);
      }
    }

    if (!entry.imageUrl) {
      stats.skippedNoUrl++;
      // Mark for triage so the user can fix manually later. Only patch if the flag isn't already set.
      if (!entry.needsManualImage && !args.dryRun) {
        try {
          await patchEntry(entry.id, { needsManualImage: true });
        } catch (err) {
          console.warn(`[manga-download]   ${entry.id} could not flag needsManualImage: ${err.message}`);
        }
      }
      continue;
    }

    if (args.limit && stats.downloaded >= args.limit) {
      console.log(`[manga-download] hit --limit ${args.limit}; stopping`);
      break;
    }

    if (args.dryRun) {
      console.log(`[manga-download] DRY ${entry.id} ← ${entry.imageUrl}`);
      stats.downloaded++;
      continue;
    }

    try {
      const result = await downloadOne(entry);
      if (result) {
        const patch = {
          imageLocalPath: toRepoRelative(result.absPath),
          needsManualImage: false,
        };
        if (result.thumbPath) patch.thumbnailPath = toRepoRelative(result.thumbPath);
        if (result.width)  patch.imageWidth  = result.width;
        if (result.height) patch.imageHeight = result.height;
        await patchEntry(entry.id, patch);

        stats.downloaded++;
        sinceCommit++;
        console.log(`[manga-download]   ${entry.id} → ${path.basename(result.absPath)}${result.thumbPath ? ' (+thumb)' : ''}`);

        if (sinceCommit >= COMMIT_BATCH_SIZE) {
          await commitBatch(stats.downloaded);
          sinceCommit = 0;
        }

        await sleep(SLEEP_BETWEEN_MS);
      }
    } catch (err) {
      stats.errored++;
      console.error(`[manga-download]   ${entry.id} FAILED: ${err.message}`);
      // Continue to next entry — never let one bad URL kill the loop.
    }
  }

  if (sinceCommit > 0) await commitBatch(stats.downloaded);

  console.log('');
  console.log('[manga-download] === summary ===');
  console.log(`[manga-download]   total entries        : ${stats.total}`);
  console.log(`[manga-download]   downloaded           : ${stats.downloaded}${args.dryRun ? ' (dry)' : ''}`);
  console.log(`[manga-download]   already had local    : ${stats.alreadyLocal}`);
  console.log(`[manga-download]   skipped (no URL)     : ${stats.skippedNoUrl}`);
  console.log(`[manga-download]   skipped (removed)    : ${stats.skippedRemoved}`);
  console.log(`[manga-download]   errored              : ${stats.errored}`);
}

// --- Download pipeline ---------------------------------------------------

async function downloadOne(entry) {
  const { buffer, contentType } = await fetchImage(entry.imageUrl);

  if (!contentType.startsWith('image/')) {
    throw new Error(`non-image content-type: ${contentType}`);
  }

  const ext = EXT_BY_MIME[contentType.toLowerCase().split(';')[0].trim()] || '.jpg';
  const fname = `${entry.id}${ext}`;
  const absPath = path.join(panelsDir, fname);

  // Don't overwrite if already exists, unless forced. (Re-uses existing bytes.)
  let wrote = false;
  try {
    await fs.access(absPath);
    if (args.force) {
      await fs.writeFile(absPath, buffer);
      wrote = true;
    }
  } catch {
    await fs.writeFile(absPath, buffer);
    wrote = true;
  }

  let thumbPath = null;
  let width = null;
  let height = null;

  const sharp = await loadSharp();
  if (sharp) {
    try {
      const img = sharp(buffer);
      const meta = await img.metadata();
      if (meta.width)  width  = meta.width;
      if (meta.height) height = meta.height;

      const thumbAbs = path.join(thumbsDir, `${entry.id}.webp`);
      let needThumb = args.force;
      if (!needThumb) {
        try { await fs.access(thumbAbs); } catch { needThumb = true; }
      }
      if (needThumb) {
        await sharp(buffer)
          .resize({
            width:  THUMB_MAX_EDGE,
            height: THUMB_MAX_EDGE,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: 80 })
          .toFile(thumbAbs);
      }
      thumbPath = thumbAbs;
    } catch (err) {
      console.warn(`[manga-download]     thumbnail failed for ${entry.id}: ${err.message}`);
    }
  }

  // Even if we re-used existing bytes, return a result so the corpus entry gets patched
  // (handles the case where files exist but corpus is missing imageLocalPath).
  return { absPath, thumbPath, width, height, wrote };
}

async function fetchImage(url, redirectsLeft = MAX_REDIRECTS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'image/*,*/*;q=0.8' },
      redirect: 'manual',
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 300 && res.status < 400) {
    const next = res.headers.get('location');
    if (!next) throw new Error(`redirect ${res.status} with no location`);
    if (redirectsLeft <= 0) throw new Error('too many redirects');
    const absNext = new URL(next, url).toString();
    return await fetchImage(absNext, redirectsLeft - 1);
  }

  if (!res.ok) throw new Error(`http ${res.status}`);

  const contentType = (res.headers.get('content-type') || '').trim();
  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  if (buffer.length === 0) throw new Error('empty response body');

  return { buffer, contentType };
}

// --- Corpus persistence (mirrors the harvester's pattern) ---------------

async function patchEntry(id, patch) {
  const corpus = await loadJson(corpusPath, []);
  const state = verbs.update_panel.apply(
    { panels: corpus, collections: [], queue: [] },
    { id, patch },
  );
  await fs.writeFile(corpusPath, JSON.stringify(state.panels, null, 2) + '\n');
}

async function commitBatch(downloadedSoFar) {
  if (args.dryRun) return;
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  if (!status.stdout?.trim()) return;
  spawnSync('git', ['add', 'data/manga-corpus/', 'images/panels/'], { cwd: repoRoot });
  const r = spawnSync('git', [
    'commit', '-m', `[manga-download] batch (${downloadedSoFar} downloaded so far) ${new Date().toISOString()}`,
  ], { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) console.error('[manga-download] commit failed:', (r.stderr || '').slice(0, 500));
}

// --- Tiny utilities ------------------------------------------------------

function toRepoRelative(abs) {
  return path.relative(repoRoot, abs).split(path.sep).join('/');
}

async function loadJson(p, fallback) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseArgs(argv) {
  const out = { dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--force') out.force = true;
    else if (argv[i] === '--limit') out.limit = parseInt(argv[++i], 10);
  }
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });
