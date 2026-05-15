#!/usr/bin/env node
// Seed data/manga-queue.json with starting topics across all four discovery
// angles: reverse-image (one item per file in seeds/), artist-deep-dive
// (canonical masters), fan-archive (curated communities), and
// splash-transition (single-manga splash/spread sweeps).
//
// Usage: node tools/manga-seed-queue.mjs [--force]

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const queuePath = path.join(repoRoot, 'data', 'manga-queue.json');
const seedsDir  = path.join(repoRoot, 'seeds');

const IMG_RE = /\.(png|jpe?g|webp|gif)$/i;

const artistDeepDive = [
  { topic: 'Kentaro Miura — Berserk splash pages, vol 14-22 (Eclipse arc)',
    reason: 'master class on screentone density + dramatic lighting' },
  { topic: 'Kentaro Miura — Berserk vol 23-32, Conviction & Falconia chapters',
    reason: 'continuation of Miura sweep into late-period craft' },
  { topic: 'Takehiko Inoue — Vagabond brush-economy panels, vol 5-25',
    reason: 'master class on negative space + gestural ink' },
  { topic: 'Takehiko Inoue — Slam Dunk peak motion sequences (Sanno arc)',
    reason: 'master class on kinetic line + frame rhythm' },
  { topic: 'Katsuhiro Otomo — Akira urban detail + mechanical density panels',
    reason: 'master class on perspective and architectural rendering' },
  { topic: 'Makoto Yukimura — Vinland Saga vol 1-15 character closeups',
    reason: 'master class on emotional restraint + clean line' },
  { topic: 'Naoki Urasawa — Pluto and Monster expression panels',
    reason: 'master class on subtle emotion + cinematic framing' },
  { topic: 'Tatsuki Fujimoto — Chainsaw Man Part 1 violent transitions',
    reason: 'modern master class on shock-cut paneling' },
  { topic: 'Tatsuki Fujimoto — Look Back + Goodbye Eri standout pages',
    reason: 'short-form composition + emotional restraint' },
  { topic: 'Hiromu Arakawa — Fullmetal Alchemist anatomy + alchemy circles',
    reason: 'master class on technical precision + dynamic poses' },
  { topic: 'Junji Ito — Uzumaki spiral motif + body horror splash pages',
    reason: 'master class on hatching + horror composition' },
  { topic: 'Junji Ito — Tomie + Gyo standout horror compositions',
    reason: 'continuation of Ito sweep into shorter works' },
];

const fanArchive = [
  { topic: 'r/manga "underrated panels" weekly digest, last 6 months',
    reason: 'community-curated picks beyond canonical masters' },
  { topic: 'Tumblr tag #manga-panels-curated — curator sample set',
    reason: 'high-signal community tag for craft-quality panels' },
  { topic: 'Pinterest board: "rare manga panels for drawing reference"',
    reason: 'visual discovery board with reference framing' },
  { topic: 'r/ArtBooks subreddit — manga tankobon scan highlight threads',
    reason: 'community focus on tankobon-only material' },
  { topic: 'Reddit r/manga "best chapter ending pages" megathread highlights',
    reason: 'transition-page focus from community curation' },
];

const splashTransition = [
  { topic: 'Berserk — every chapter title page splash, vol 1-41',
    reason: 'splash-page sweep on canonical title-page series' },
  { topic: 'Vagabond — every double-page spread, vol 1-37',
    reason: 'spread-page sweep across Inoue\'s peak format' },
  { topic: '20th Century Boys — silent transition pages',
    reason: 'Urasawa\'s wordless cinematic transitions' },
  { topic: 'Akira — full double-spread machinery / explosion pages',
    reason: 'Otomo spread-page sweep for environmental detail' },
  { topic: 'Blame! — wide-shot architectural transitions',
    reason: 'Nihei silent architectural panel sweep' },
  { topic: 'Dorohedoro — chapter-opening splash pages',
    reason: 'Hayashida title-page sweep for textured pen work' },
  { topic: 'Made in Abyss — environmental establishing splash pages',
    reason: 'Tsukushi splash sweep for landscape detail' },
  { topic: 'Vinland Saga — silent emotional transition pages',
    reason: 'Yukimura wordless transition sweep' },
];

async function listSeedFiles(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && IMG_RE.test(e.name))
      .map((e) => path.join('seeds', e.name).replace(/\\/g, '/'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function main() {
  const force = process.argv.includes('--force');
  await fs.mkdir(path.dirname(queuePath), { recursive: true });

  try {
    const existing = JSON.parse(await fs.readFile(queuePath, 'utf8'));
    if (!force && Array.isArray(existing) && existing.length > 0) {
      console.error(`[manga-seed] ${queuePath} already has ${existing.length} items. Use --force to overwrite.`);
      process.exit(1);
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }

  const seedFiles = await listSeedFiles(seedsDir);
  const enqueuedAt = new Date().toISOString();
  const stamp = (extra) => ({ ...extra, requestedBy: 'seed', enqueuedAt, attempts: 0 });

  const reverseImage = seedFiles.map((p) => stamp({
    topic: `Reverse-image discovery for seed ${path.basename(p)}`,
    discoveryAngle: 'reverse-image',
    reason: 'User seed — train on existing taste',
    input: { seedPath: p },
  }));

  const queue = [
    ...reverseImage,
    ...artistDeepDive.map((t) => stamp({ ...t, discoveryAngle: 'artist-deep-dive' })),
    ...fanArchive.map((t) => stamp({ ...t, discoveryAngle: 'fan-archive' })),
    ...splashTransition.map((t) => stamp({ ...t, discoveryAngle: 'splash-transition' })),
  ];

  await fs.writeFile(queuePath, JSON.stringify(queue, null, 2) + '\n');
  console.log(`[manga-seed] wrote ${queue.length} items to ${queuePath}`);
  console.log(`  reverse-image:     ${reverseImage.length}`);
  console.log(`  artist-deep-dive:  ${artistDeepDive.length}`);
  console.log(`  fan-archive:       ${fanArchive.length}`);
  console.log(`  splash-transition: ${splashTransition.length}`);
  if (!seedFiles.length) {
    console.log(`  (no images in seeds/ — drop png/jpg/webp files there to seed reverse-image discovery)`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
