# Auralith Pro v1.12.4 — Payment Settlement Hardening

## Changes
- Payment settlement checks the provider merchant reference, currency, and exact expected amount before activating Pro. Overpayments or underpayments are treated as mismatches for manual reconciliation.
- Settlement claims a transaction as `processing` before writing an entitlement so concurrent IPN/browser verification requests do not both extend a subscription.
- A stale processing claim can be recovered after a two-minute grace period. If the matching entitlement already records the same `tx_ref`, recovery finalizes the transaction without extending the plan again.
- Reversed payments attempt to revoke only the entitlement associated with that payment and fail visibly if the database update fails.
- The service-worker cache key and app script URL were bumped to reduce stale-client issues after deployment.

## Required validation before production
1. Back up Supabase and apply the pending v1.12.2 and v1.12.3 migrations from the previous release if not already applied.
2. Confirm `pro_transactions` has `status`, `updated_at`, `provider_transaction_id`, `provider_response`, `tx_ref`, `user_id`, `plan`, `amount`, and `currency`; confirm `pro_entitlements` has `tx_ref`, `status`, `expires_at`, and the fields used by `api/_pro.js`.
3. In Pesapal sandbox, test each plan with successful, pending, failed, wrong-amount, wrong-currency, wrong-reference, duplicate-IPN, concurrent-IPN/browser-return, and reversed-payment scenarios.
4. Test a simulated interruption after entitlement write but before transaction finalization, then retry and confirm the same transaction does not extend the plan twice.
5. Verify service-role credentials exist only in server-side Vercel environment variables, and `PUBLIC_APP_URL` is the canonical HTTPS production origin.
6. Only after preview tests pass, deploy the same ZIP to production and verify entitlement status against Supabase and Pesapal records.

## Limitations
- This is source-level hardening, not proof of a live payment integration. No live Pesapal or Supabase credentials were used in these checks.
- The database schema was inferred from existing API queries because the repository does not contain a complete base schema migration. Confirm it against the actual Supabase project before deployment.
- A database/network failure during reversal or settlement still requires monitoring and reconciliation.
