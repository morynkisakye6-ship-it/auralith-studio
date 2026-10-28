# Auralith Studio v2.0.1

Auralith Studio is the new product identity for Auralith. The existing graphite, brass, and muted-teal visual language is retained.

## Compatibility choices
- Existing hosted app URL and Supabase configuration are retained.
- Capacitor app ID remains `com.tapehead.pro` so existing installations can receive an update instead of becoming a separate app.
- Internal `AuralithCloud` and related globals remain stable until a tested compatibility migration is ready.

## Validation
- `node scripts/verify-mobile-package.mjs` — passed.
- `node scripts/verify-engineering.mjs` — passed.
- `node --test www/tests/*.test.mjs` — 100 tests passed.

## Release note
The production studio still uses its existing monolithic UI orchestrator. See `ENGINEERING-REBUILD.md` for the staged plan to decompose it without sacrificing current behavior.


### Engineering follow-up: v2.0.1 runtime extraction

- Extracted command throttling and diagnostics into `www/js/runtime.js`.
- Added isolated runtime unit tests and included the module in engineering verification.
- Bumped runtime cache version so deployed browsers do not keep the old controller bundle cached.
- This remains an incremental modernization, not a claim that all legacy UI orchestration has been rewritten.
