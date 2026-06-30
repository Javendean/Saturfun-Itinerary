// Sliding-window-counter rate limiter backed by Workers KV.
//
// Approach: one KV key per IP (`rl:<ip>`). Value is a JSON list of UNIX-second
// timestamps for recent requests. On each call we:
//   1. read current timestamps,
//   2. drop entries older than `windowSeconds`,
//   3. if count >= max, reject (and DO NOT write — saves a write op),
//   4. otherwise append `now`, write back with `expirationTtl = windowSeconds`.
//
// Notes:
// - KV write rate limit is 1 write/sec/key, which is fine: a per-IP key under
//   load only sees writes at the application's allowed rate.
// - KV reads are eventually consistent within ~60s, so a determined attacker
//   can briefly exceed the window across edge POPs. That's acceptable for a
//   public-visitor LLM fallback whose hard cap is the daily neuron budget.
// - We deliberately skip rate-limiting when the IP is unknown — better to
//   serve the request than to lock ourselves out behind a CDN we trust.

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
}

export async function checkRateLimit(
  kv: KVNamespace,
  ip: string,
  max: number,
  windowSeconds: number,
  keyPrefix = "rl",
): Promise<RateLimitResult> {
  const key = `${keyPrefix}:${ip}`;
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - windowSeconds;

  let timestamps: number[] = [];
  const raw = await kv.get(key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        timestamps = parsed.filter(
          (t): t is number => typeof t === "number" && t > cutoff,
        );
      }
    } catch {
      // Corrupt entry — treat as empty.
    }
  }

  if (timestamps.length >= max) {
    const oldest = timestamps[0] ?? now;
    const resetSeconds = Math.max(1, oldest + windowSeconds - now);
    return { allowed: false, remaining: 0, resetSeconds };
  }

  timestamps.push(now);
  // Fire-and-forget the write — we don't need to block the response on it,
  // but we also can't lose it. `waitUntil` would be cleaner; for simplicity
  // we await here. The cost is one extra ~5ms KV write before streaming.
  await kv.put(key, JSON.stringify(timestamps), {
    expirationTtl: windowSeconds * 2, // belt-and-suspenders
  });

  return {
    allowed: true,
    remaining: max - timestamps.length,
    resetSeconds: windowSeconds,
  };
}
