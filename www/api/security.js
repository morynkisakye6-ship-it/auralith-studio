/** Shared server-side security helpers for Auralith API routes. */

const ipBuckets = new Map(); // ip -> { count, resetAt }

export function clientIp(req) {
  // Prefer the platform-provided single-hop address. If unavailable, use the
  // rightmost forwarded address (the proxy-appended hop), not the caller-controlled
  // leftmost value, which can be spoofed to evade per-IP throttling.
  const realIp = String(req.headers['x-real-ip'] || '').trim();
  if (realIp) return realIp.slice(0, 128);
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean);
  return (forwarded.at(-1) || req.socket?.remoteAddress || 'unknown').slice(0, 128);
}

/** Per-instance fallback limiter keyed by an arbitrary bucket string. */
function memoryLimit(bucketKey, { limit = 60, windowMs = 60_000 } = {}) {
  const now = Date.now();
  let b = ipBuckets.get(bucketKey);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    // Opportunistically prune expired entries and cap memory use.
    if (ipBuckets.size >= 5000) {
      for (const [k, bucket] of ipBuckets) {
        if (now >= bucket.resetAt || ipBuckets.size >= 4000) ipBuckets.delete(k);
        if (ipBuckets.size < 4000) break;
      }
    }
    ipBuckets.set(bucketKey, b);
  }
  b.count += 1;
  if (b.count > limit) return { ok: false, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  return { ok: true, remaining: limit - b.count };
}

/** Legacy synchronous per-instance IP limit. Prefer rateLimit(). */
export function rateLimitIp(req, { limit = 60, windowMs = 60_000 } = {}) {
  const ip = clientIp(req);
  return { ...memoryLimit('legacy:' + ip, { limit, windowMs }), ip };
}

const UPSTASH_URL = () => String(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const UPSTASH_TOKEN = () => String(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '');
let lastBackendWarn = 0;

/** True when a shared (cross-instance) limiter store is configured. */
export function distributedLimiterConfigured() { return !!(UPSTASH_URL() && UPSTASH_TOKEN()); }

/**
 * Fixed-window counter in Upstash Redis (REST, no dependency). One pipelined round trip:
 * INCR, EXPIRE NX (sets the TTL only on the first hit of a window), PTTL.
 * Throws on any transport/HTTP/shape error so the caller can degrade.
 */
async function redisHit(key, windowMs) {
  const r = await fetch(`${UPSTASH_URL()}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['INCR', key], ['EXPIRE', key, Math.ceil(windowMs / 1000), 'NX'], ['PTTL', key]]),
    signal: AbortSignal.timeout(1500)
  });
  if (!r.ok) throw new Error(`limiter store HTTP ${r.status}`);
  const out = await r.json();
  const count = Number(out?.[0]?.result);
  let ttl = Number(out?.[2]?.result);
  if (!Number.isFinite(count) || out?.[0]?.error) throw new Error('limiter store bad response');
  if (!Number.isFinite(ttl) || ttl < 0) {
    // Key exists without a TTL (e.g. EXPIRE failed): repair so a counter can never stick forever.
    ttl = windowMs;
    await fetch(`${UPSTASH_URL()}/pipeline`, {
      method: 'POST', headers: { Authorization: `Bearer ${UPSTASH_TOKEN()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['PEXPIRE', key, windowMs]]), signal: AbortSignal.timeout(1500)
    }).catch(() => {});
  }
  return { count, ttl };
}

/**
 * Shared rate limit. `name` namespaces the bucket per route; `key` defaults to the client IP
 * (pass a user id for per-account limits). Uses Upstash Redis when configured so counts are
 * global across serverless instances. If the store is unset or errors, it DEGRADES to the
 * per-instance in-memory limiter (never fail-open entirely, never lock every user out) and
 * reports backend: 'memory'.
 */
export async function rateLimit(req, { name = 'api', limit = 60, windowMs = 60_000, key } = {}) {
  const ip = clientIp(req);
  const id = String(key || ip).slice(0, 128);
  const bucket = `th:rl:${String(name).slice(0, 40)}:${id}`;
  if (distributedLimiterConfigured()) {
    try {
      const { count, ttl } = await redisHit(bucket, windowMs);
      if (count > limit) return { ok: false, retryAfter: Math.max(1, Math.ceil(ttl / 1000)), ip, backend: 'redis' };
      return { ok: true, remaining: limit - count, ip, backend: 'redis' };
    } catch (e) {
      if (Date.now() - lastBackendWarn > 60_000) { lastBackendWarn = Date.now(); console.error('[Auralith] distributed limiter unavailable, using per-instance fallback:', e.message); }
    }
  }
  const m = memoryLimit(bucket, { limit, windowMs });
  return { ...m, ip, backend: 'memory' };
}

export function clean(v, max = 12000) {
  return String(v || '').replace(/\u0000/g, '').trim().slice(0, max);
}

/** Plan-aware AI hourly limits. */
export function aiLimitForPlan(plan) {
  const p = String(plan || 'trial').toLowerCase();
  if (p === 'lifetime' || p === 'year' || p === 'yearly') return 60;
  if (p === 'month' || p === 'monthly') return 45;
  if (p === 'trial') return 20;
  return 15;
}

export const ALLOWED_AI_ACTIONS = new Set([
  'finish_verse', 'next_section', 'polish', 'hook', 'full_song'
]);

/** Test-only: clear the in-memory fallback limiter between test cases. */
export function __resetRateLimitsForTests() { ipBuckets.clear(); }
