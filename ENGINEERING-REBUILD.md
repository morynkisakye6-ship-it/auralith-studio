# Auralith Studio 2.0 — Engineering Rebuild Notes

## Product direction

Auralith Studio is the new product identity for the Auralith music studio. The existing dark graphite, warm brass, and muted teal palette is intentionally preserved. This release keeps the existing hosted service endpoint, Supabase project, database contract, and Capacitor application ID so deployed users and existing native installations are not silently disconnected.

## Engineering guardrails in this release

- Explicit package version and display identity (`2.0.0`, Auralith Studio).
- Stable Capacitor `appId` (`com.tapehead.pro`) to preserve update continuity for existing Android/iOS installations. Do not change this without a deliberate migration plan.
- HTTPS-only native hosted content; cleartext traffic remains disabled.
- Automated package checks plus a separate engineering verifier for identity, security defaults, and key visual tokens.
- Unit/regression test command separated from environment-dependent two-user authorization/RLS integration checks.
- Existing cloud globals (`AuralithCloud`, `AURALITH_CLOUD`) are retained as compatibility interfaces; renaming them is a separate migration, not a cosmetic search/replace.

## Commands

```sh
npm install
npm run verify:engineering
npm run verify:mobile
npm test
```

The two-user scripts under `www/scripts/` require correctly configured Supabase test credentials and should be run as an environment-backed integration suite. They are not equivalent to offline unit tests.

## Important scope note

This release establishes a safer v2 product/package baseline and branding transition while preserving the working production architecture. It does **not** claim that the legacy monolithic studio UI has already been fully decomposed or rewritten. The next engineering phase should move the inline application shell and `www/app.js` into tested feature modules behind stable interfaces (studio state, audio engine, projects, auth/cloud, collaboration, and payments), with a feature-parity checklist and staged regression tests before replacing the current entry point.


## Incremental refactor: runtime guard boundary (v2.0.1)

The command double-tap guard and command diagnostics are now isolated in `www/js/runtime.js`, loaded before the main studio controller. The module exposes a small `AuralithRuntime` API and keeps `thAllowCommandTap` / `thRecordCommand` compatibility bridges for legacy inline handlers. It is covered by independent Node tests. This is a low-risk first extraction; `www/app.js` remains the legacy orchestration boundary and should be decomposed feature-by-feature with browser regression coverage rather than mechanically splitting closure-dependent functions.
