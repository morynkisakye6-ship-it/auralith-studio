# Tapehead Pro v1.12.6 — Payment Reversal Recovery

## Changes
- Reversed Pesapal transactions now revoke the entitlement tied to that exact `tx_ref` even when the transaction row is still marked `processing`. This covers the partial-settlement case where entitlement creation succeeded but transaction finalization failed before a later reversal arrived.
- Reversal handling remains scoped by both user ID and transaction reference so unrelated entitlements are not targeted.
- Added source assertions to guard the partial-settlement reversal behavior.
- Bumped app and service-worker cache versions.

## Validation
- `node scripts/verify-security.mjs` passes, including the new reversal recovery assertions.
- JavaScript syntax checks pass for the changed payment helper and verification script.
- ZIP integrity checked after packaging.

## Important limitation
These are static/source-level checks. No Pesapal sandbox payment or live Supabase mutation was executed. Test successful payments, reversals, duplicate callbacks, and interrupted settlement in a preview environment before production deployment. Confirm the deployed schema and service-role permissions first.
