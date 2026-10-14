# Tapehead Pro v1.12.12 — Automated Security Regression Suite

## Added
- `tests/` (58 behavioural tests, Node 22, zero dependencies) running the real API handlers and `js/cloud.js` against a stateful fake of Supabase and Pesapal with fault injection.
  - Unauthorized access: forged tokens, other users' transactions and jobs, worker secret, spoofed room/user ids, path traversal.
  - Duplicate requests: sequential and concurrent IPN/verify callbacks, concurrent trial claims, concurrent AI calls against the hourly quota.
  - Failure recovery: crash before/after the entitlement write, provider outage, missing quota/claim RPCs (fail closed), storage listing/delete failures during account deletion, orphan cleanup at every upload step.
  - Throttling: 429 + Retry-After, per-IP isolation, `X-Forwarded-For` spoofing.
- `.github/workflows/security.yml`: offline job on every push/PR; live two-account staging job on pushes/manual runs (skipped, with a warning, if `STAGING_*` secrets are absent; refuses URLs that look like production; never runs with fork-PR secrets).
- `scripts/verify-security.mjs` now also checks the suite and workflow exist.

## Bug found by the suite and fixed
- File names containing `..` (e.g. `my..take.wav`) passed the upload sanitizer, but account deletion rejected any storage entry containing `..` and fails closed, so such a user could never delete their account. Upload now collapses repeated dots; deletion now rejects only real traversal (`/`, `\`, `.`, `..` as a whole name), so existing legacy files delete correctly.

## Suite quality check
The suite was run against 12 deliberate regressions (amount check removed, claim guard removed, trial always granted, AI entitlement/quota skipped, deletion ignoring listing errors, job IDOR, upload cleanup removed, upsert enabled, limiter disabled, worker secret skipped, verify owner check removed). Final run: all 12 caught. One initially slipped through (quota hidden behind the burst limiter) and the quota tests were rewritten to isolate it.

## To turn on
1. Add the workflow (repo root must contain `www/`; otherwise see the comment at the top of the file).
2. GitHub, Settings, Branches: require the `offline` check before merging to main. In Vercel, enable "Require checks to pass before deploying" so a failing run blocks the deploy.
3. For the live job, create a staging Supabase project plus 3 test users and add secrets `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_ANON_KEY`, `STAGING_USER_{A,B,C}_{EMAIL,PASSWORD}`.

## Not covered / honest limits
- The fakes model PostgREST/Supabase behavior as the code expects it; they cannot prove real Postgres policies or locks. The live staging job does that, and has not been run.
- True concurrency inside Postgres (the atomic quota and trial RPCs) is only verifiable live; offline tests check the API's handling of the RPC results.
- No browser/UI tests; priority 5 (mobile QA) covers that.
