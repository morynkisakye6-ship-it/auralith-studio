# Security regression tests

Run everything offline (Node 22+, no dependencies, no network):

    node scripts/verify-security.mjs
    node scripts/test-limiter.mjs
    node --test tests/*.test.mjs

| File | Covers |
|---|---|
| `payments.test.mjs` | duplicate/concurrent IPN + verify callbacks, amount/currency/reference tampering, reversals, crash recovery mid-settlement, cross-user verify |
| `trial-ai.test.mjs` | one-time trial under concurrency, fail-closed claims, AI auth/entitlement/quota ordering, upstream never called when denied |
| `delete-jobs.test.mjs` | account deletion order and fail-closed behavior, cross-prefix safety, job IDOR, worker secret, server-controlled priority |
| `client-upload.test.mjs` | `js/cloud.js` upload binding, input validation, path traversal, orphan cleanup on every failure step, join/save contracts |
| `route-throttle.test.mjs` | 429 + Retry-After, per-IP isolation, spoofed `X-Forwarded-For` |

`helpers.mjs` is a stateful fake of Supabase (auth, PostgREST filters, RPCs, storage) and Pesapal with fault injection
(`cloud.fault(predicate, { status, times })`). Handlers run against it unchanged.

## Live tests (staging only)
`scripts/two-user-authz-test.mjs` and `scripts/two-user-rls-test.mjs` need two or three real staging accounts; see their headers.
CI runs them on pushes when the `STAGING_*` secrets exist.

## When you add a feature
Add a test for: unauthenticated access, access as another user, a duplicate/concurrent request, and a failure halfway through.
A test that cannot fail is worthless: temporarily break the control and confirm the test goes red.
