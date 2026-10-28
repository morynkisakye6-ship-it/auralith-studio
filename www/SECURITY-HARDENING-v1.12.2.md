# Auralith Pro v1.12.2 — Atomic AI quota

## Changes
- AI route now uses the `reserve_ai_usage` RPC, which atomically checks and records allowance under a per-user transaction advisory lock.
- Removed the unsafe count-then-record fallback. If the RPC is missing or inaccessible, Cloud AI fails closed and reports it as not configured.
- Each accepted attempt reserves an allowance immediately. Failed upstream attempts also count for the hour to prevent abuse/retry storms; revisit this product policy if you later implement expiring reservation records.
- Added Supabase migration at `supabase/migrations/20261010_atomic_ai_usage.sql`.

## Required deployment order
1. Back up the Supabase database.
2. Confirm `public.ai_usage` exists with `user_id` (UUID-compatible) and `created_at` (timestamp/timestamptz) columns. Adjust the migration if your actual schema differs.
3. Apply the SQL migration to the correct Supabase project.
4. Run `node scripts/verify-security.mjs` from this folder.
5. Deploy this build to a preview environment and test concurrent AI requests using a test account.
6. Promote only after the checks pass.

## Verification boundary
Source tests cannot verify the live Supabase schema, database grants, or Vercel environment. Do not claim the quota is protected until the migration is applied and concurrent requests are tested against the real database.
