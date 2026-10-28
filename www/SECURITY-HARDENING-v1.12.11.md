# Auralith Pro v1.12.11 — Distributed Rate Limiting

## What changed
- `api/security.js`: new async `rateLimit(req, { name, limit, windowMs, key })`. With Upstash Redis configured it keeps one fixed-window counter shared by every serverless instance (INCR + EXPIRE NX + PTTL in one request, 1.5 s timeout). Buckets are namespaced per route and keyed by IP or by user id.
- Store unset or down: degrades to the old per-instance limiter (still limits, never throws, logs at most once a minute). It does not fail closed, so a Redis outage cannot lock users out of account deletion or checkout.
- All limited routes moved to it. New limits on routes that had none: `pro-checkout` (20/min/IP, 6 per 10 min/user), `pro-verify` (40/min/IP), `pesapal-ipn` (300/min/IP, deliberately generous), `pro-status` (120/min/IP). `ai` gains a per-user 20/min burst limit on top of the DB hourly quota.
- `supabase/migrations/20261013_distributed_rate_limits.sql`: Postgres counter (`rate_limits`, `rate_limit_hit`) and per-user BEFORE INSERT limits on messages, comments, collab_messages, reports, follows, blocks, feed_posts, likes, rooms and room_vocals. The browser writes to these tables directly, so only the database can throttle them.
- `join_room_limited()` wraps `join_room()` (10/min and 60/hour per user, failed attempts still counted); `join_room` is no longer callable by clients. The client now calls the wrapper.
- Tests: `scripts/test-limiter.mjs` (offline, mock Upstash: limit, isolation, cross-instance sharing, outage fallback, bad credentials), new live checks in `scripts/two-user-rls-test.mjs`, source assertions in `scripts/verify-security.mjs`.

## To enable
1. Create an Upstash Redis database (free tier is fine). In Vercel set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (the Vercel/Upstash integration's `KV_REST_API_URL` / `KV_REST_API_TOKEN` also work). Redeploy.
2. Apply `20261013_distributed_rate_limits.sql` to staging, run `scripts/two-user-rls-test.mjs`, then production.
3. After deploying, confirm the limiter is shared: exceed a limit from two different networks/regions and check responses are 429 together; Vercel logs show `distributed limiter unavailable` if Redis is unreachable.

## Limits and not verified
- Tested only against a mock Upstash server and by source assertions. Nothing was run against real Upstash or Supabase.
- Fixed windows allow up to 2x the limit across a window boundary.
- `join_room` must return a scalar; if it returns void, adjust the wrapper (note at the end of the migration).
- IP limits behind shared NAT (schools, mobile carriers) can throttle innocent users; limits are intentionally loose.
- Supabase Auth (signup, login, password reset) is not covered here. Set its rate limits and enable CAPTCHA in the Supabase dashboard.
- Upserts fire BEFORE INSERT triggers even when they update, so very frequent upserts to feed_posts/rooms count against their limits.
- A user with many accounts is not stopped by per-user limits; that needs signup friction (CAPTCHA, email verification).
