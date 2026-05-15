#!/usr/bin/env node
// Seed data/queue.json with the initial research backlog:
//   (a) re-research existing venues to fill schema gaps + photos
//   (b) expand weak checkpoints with 4-6 candidates each, scoped to driving radius
//
// Usage: node tools/seed-queue.mjs [--force]
// --force overwrites an existing queue.json.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const queuePath = path.join(repoRoot, 'data', 'queue.json');

const existingVenues = [
  'Colson Patisserie', 'Yafa Cafe', 'Japan Village', 'BOOKOFF', 'Makers Guild',
  'Tacos El Bronco', 'Ba Xuyên', 'Hainan Chicken House', 'Kai Feng Fu Dumpling House',
  'Beat The Bomb', 'Movement Gowanus', 'Kick Axe', 'Brooklyn Game Knight',
  'Carreau Club', 'Melody Lanes', 'WakuWaku', 'Hometown BBQ',
  'Xin Fa Bakery', 'Japan Village Food Hall',
];

const expansionTopics = [
  // Weak blocks per the context doc — Commute (1), Coffee (2), Dinner (2), Dessert (2).
  { topic: 'Best driving-friendly coffee spots in Industry City, Sunset Park, or 10-15 min drive radius', reason: 'expand 11:30 AM Coffee block' },
  { topic: 'Specialty pastry / morning bakery near Industry City with weekend parking', reason: 'expand 11:30 AM Coffee block' },
  { topic: 'Pre-dinner dinner alternatives in Red Hook, Carroll Gardens, Cobble Hill, Park Slope', reason: 'expand 6:30 PM Dinner block' },
  { topic: 'Distinctive Brooklyn dinner spots within 15 min drive of Industry City, vegetarian-friendly', reason: 'expand 6:30 PM Dinner block' },
  { topic: 'Late-evening dessert venues open past 9 PM in Sunset Park, Brooklyn Chinatown, Williamsburg', reason: 'expand 8:00 PM Dessert block' },
  { topic: 'Korean / Japanese / Taiwanese dessert shops within driving radius of IC', reason: 'expand 8:00 PM Dessert block' },
  // New time-block candidates (decisions deferred per plan, but corpus needs to surface candidates).
  { topic: 'Sunset photo + walk spots accessible by car: Greenwood Cemetery, BBP Pier 6, Brooklyn Heights Promenade, DUMBO waterfront', reason: 'candidate 5 PM Sunset Wander block' },
  { topic: 'Late-night Williamsburg cocktail bars with weekend availability and parking', reason: 'candidate 10 PM Late Night block' },
  { topic: 'Red Hook late-night bars and music venues with parking', reason: 'candidate 10 PM Late Night block' },
  { topic: 'Comedy clubs and live music venues in Brooklyn open past 10 PM, 20 min drive from IC max', reason: 'candidate 10 PM Late Night block' },
];

async function main() {
  const force = process.argv.includes('--force');
  await fs.mkdir(path.dirname(queuePath), { recursive: true });

  try {
    const existing = JSON.parse(await fs.readFile(queuePath, 'utf8'));
    if (!force && Array.isArray(existing) && existing.length > 0) {
      console.error(`[seed-queue] ${queuePath} already has ${existing.length} items. Use --force to overwrite.`);
      process.exit(1);
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }

  const enqueuedAt = new Date().toISOString();
  const queue = [
    ...existingVenues.map((name) => ({
      topic: `Re-research existing venue: ${name}`,
      reason: 'fill duration / zone / vibe / dietary / priceBand / photo',
      requestedBy: 'seed',
      enqueuedAt,
    })),
    ...expansionTopics.map((t) => ({ ...t, requestedBy: 'seed', enqueuedAt })),
  ];

  await fs.writeFile(queuePath, JSON.stringify(queue, null, 2) + '\n');
  console.log(`[seed-queue] wrote ${queue.length} items to ${queuePath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
