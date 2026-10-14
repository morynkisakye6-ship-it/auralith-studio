# Tapehead Pro v1.12.7 — Abuse Resistance Hardening

## Changes
- IP rate limiting prefers the platform-provided `x-real-ip`; the fallback uses the rightmost forwarded hop instead of the spoofable leftmost value.
- Added per-instance rate limits to account deletion (5 attempts/minute/IP) and trial claims (15 attempts/minute/IP), with `Retry-After` responses. Database uniqueness remains the authoritative trial anti-replay control.
- Added HSTS, disabled DNS prefetching, and disabled cross-domain policy files in global response headers.
- Extended source verification to cover these protections.

## Validation and limitations
These are source-level controls. The in-memory IP limiter is per serverless instance and can be bypassed across instances; it is not a substitute for a shared distributed rate limiter or Vercel edge controls. HSTS with `includeSubDomains` should only be deployed if every subdomain is HTTPS-ready. No live production or provider test was run.
