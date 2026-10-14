# Tapehead Pro v1.12.5 — Payment Integrity Guard

## Changes
- Settlement now verifies three amount/currency relationships before activation: provider-reported amount versus the transaction, stored transaction amount versus the configured price for that plan, and stored/provider currency versus the configured currency.
- Checkout now requires the Pesapal order tracking ID to be persisted against exactly one still-pending transaction before returning the payment link. A failed or ambiguous database binding no longer silently returns a usable checkout URL.
- Bumped the app and service-worker cache version.

## Validation
Run `node scripts/verify-security.mjs` and syntax-check all JavaScript files. These checks are static/source-level and do not replace integration testing.

## Production gates
1. Confirm Supabase `pro_transactions` columns and permissions against the live schema.
2. Apply the previous atomic AI quota and Pro trial migrations if not already applied; backfill historical trial claims before deploying that trial migration.
3. In Pesapal sandbox, test successful, pending, failed, reversed, wrong-amount, wrong-currency, wrong-reference, duplicate-IPN, concurrent IPN/browser-return, and interrupted-settlement cases.
4. If plan prices or currency change while an order is pending, reconcile or expire those orders rather than changing a transaction record manually.
5. Deploy to preview first. No live Pesapal or Supabase credentials were used in this build.
