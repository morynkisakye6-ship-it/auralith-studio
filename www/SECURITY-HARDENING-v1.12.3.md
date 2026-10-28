# Auralith Pro v1.12.3 — Trial Claim Hardening

## Changes
- Trial eligibility is claimed through a database RPC backed by a unique `user_id` primary key. Concurrent requests cannot both claim a trial.
- Claims persist independently of entitlement expiration or replacement, preventing repeated trials for the same account.
- The trial endpoint fails closed when the RPC or service-role configuration is unavailable.
- The endpoint no longer relies on a check-then-insert query as its concurrency control.

## Deployment gate
1. Back up the database.
2. Review and apply `supabase/migrations/20261010_atomic_pro_trial.sql` to the intended Supabase project.
3. Confirm service-role access remains server-only.
4. Deploy to a preview environment and test first-time, repeat, and concurrent trial requests using test accounts.
5. Reconcile existing trial users before relying on the new table. Existing users with a historical trial entitlement are not automatically backfilled into `pro_trial_claims`; backfill them before enabling this route in production, otherwise historical users could potentially claim again.

## Known operational trade-off
If a claim succeeds but entitlement creation fails, the claim remains and the trial is not automatically retried. Reconcile the claim and entitlement server-side rather than deleting the claim blindly.

## Verification scope
Source-level tests do not prove deployed configuration, database permissions, payment-provider behavior, or live app correctness.
