#!/usr/bin/env node
// Verify the deployed Worker can answer well when handed Industry City context.
// Picks 5 IC venues from the corpus, POSTs to the Worker, prints streamed output.
//
// Usage: node tools/test-worker.mjs

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpusPath = path.join(repoRoot, 'data', 'corpus', 'index.json');
const WORKER = 'https://saturfun-worker.javendean.workers.dev/api/chat';
const ORIGIN = 'https://javendean.github.io';

async function main() {
  const corpus = JSON.parse(await fs.readFile(corpusPath, 'utf8'));
  const ic = corpus.filter(e => /industry.city/i.test(e.zone || ''));
  console.log(`[corpus] picked ${ic.length} IC entries; sending top 5 to worker`);

  // Pick a handful of well-known IC venues we know the corpus describes.
  const picks = ['japan-village', 'sahadi', 'colson', 'industry-city', 'guild'];
  const ctx = [];
  for (const term of picks) {
    const m = ic.find(e => new RegExp(term, 'i').test(e.name || ''));
    if (m && !ctx.find(c => c.id === m.id)) ctx.push(m);
  }
  while (ctx.length < 5 && ic.length > ctx.length) ctx.push(ic[ctx.length]);
  ctx.length = Math.min(5, ctx.length);

  console.log('[worker] context entries:');
  ctx.forEach((e, i) => console.log(`  ${i + 1}. ${e.name}  [${e.zone}]`));

  const res = await fetch(WORKER, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': ORIGIN,
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'What restaurants are at Industry City?' }],
      context: ctx,
    }),
  });

  console.log(`\n[worker] status=${res.status} ok=${res.ok}`);
  if (!res.ok) {
    const t = await res.text();
    console.log('[worker] body:', t.slice(0, 500));
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let acc = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          console.log('\n--- response ---');
          console.log(acc);
          console.log('--- end ---');
          return;
        }
        try {
          const obj = JSON.parse(payload);
          if (obj.error) { console.log('\n[worker] ERROR:', obj.error); return; }
          if (typeof obj.response === 'string') acc += obj.response;
        } catch { /* ignore */ }
      }
    }
  }
  console.log('\n--- response (no DONE) ---');
  console.log(acc);
}

main().catch((e) => { console.error(e); process.exit(1); });
