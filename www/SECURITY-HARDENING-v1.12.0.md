# Tapehead Pro v1.12.0 — Security hardening notes

## Changes in this package
- Internal job processing now fails closed with HTTP 503 when neither `JOBS_PROCESS_SECRET` nor `CRON_SECRET` is configured, and rejects missing or incorrect credentials.
- Client-supplied job priorities are ignored; the server chooses priorities by job type.
- Per-instance IP rate-limit storage prunes expired entries and caps its map size. This is only a memory safeguard, not a substitute for shared distributed rate limiting.
- Service-worker cache and script URLs are versioned together to reduce stale-app behavior after deployment.

## Required Vercel environment variables
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server-only; never expose with a `VITE_`/`NEXT_PUBLIC_` prefix)
- `OPENAI_API_KEY` (server-only)
- `JOBS_PROCESS_SECRET` or `CRON_SECRET` (high-entropy random secret; required to run queued jobs)
- Pesapal credentials only if payments are enabled

## Production hardening still required
- Apply and verify the Supabase SQL migrations and restrictive RLS policies in the actual project.
- Replace in-memory rate limiting and AI usage check-then-record logic with atomic, shared database/RPC enforcement.
- Add automated integration tests for auth, entitlement, payment replay, job ownership, cancellation, quota races and failure recovery.
- Configure production monitoring, dependency scanning, backup/restore tests and incident-response rotation for leaked credentials.
- Front-end code delivered to browsers can always be copied. Protect proprietary logic by keeping sensitive decisions and valuable algorithms server-side; minification/obfuscation is not a security boundary.

## Verification boundary
This package has source-level checks only. Live Vercel/Supabase/Pesapal behavior and environment configuration must be tested after deployment; a successful ZIP check does not prove production security.
