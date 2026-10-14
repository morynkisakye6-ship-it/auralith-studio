# Tapehead Pro v1.12.1 — Security hardening

## Added in this build
- Payment checkout and Pesapal IPN setup now use only the explicitly configured `PUBLIC_APP_URL`; request `Origin` is no longer trusted as a fallback.
- The configured URL is validated, rejects credentials/query/hash/path components, and requires HTTPS in production. HTTP is accepted only for localhost during non-production development.
- Added dependency-free source checks at `scripts/verify-security.mjs`. Run with `node scripts/verify-security.mjs` from `tapehead/www`.

## Deployment requirement
Set `PUBLIC_APP_URL` to the canonical HTTPS origin for the deployed site (for example, `https://your-real-domain.example`) in Vercel Environment Variables. Do not copy the example literally. If unset or invalid, checkout fails closed rather than trusting caller-controlled headers.

## Remaining production work
- Confirm actual Supabase RLS policies and SQL RPCs in the connected project.
- Replace check-then-record AI quotas with atomic, shared quota reservation; current per-instance IP throttling is not global.
- Add automated integration tests for authentication, trial concurrency, payment callback replay, job ownership, quota races, and account deletion.
- Add CSP after auditing inline scripts, plus dependency scanning, backup/restore drills, monitoring, and credential rotation.

## Verification boundary
Source-level checks do not prove live Vercel, Supabase, or Pesapal behavior.
