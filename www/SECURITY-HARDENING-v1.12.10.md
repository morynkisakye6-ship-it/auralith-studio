# Tapehead Pro v1.12.10 — Database Ownership and Row Level Security

## Scope
- `supabase/migrations/20261011_private_audio_rls.sql`: private `vocals` bucket, owner-folder storage policies, room-member read access, no UPDATE (no overwrite), `room_vocals` RLS.
- `supabase/migrations/20261012_database_ownership_rls.sql`: RLS for profiles, projects, feed_posts, likes, comments, follows, blocks, reports, messages, rooms, room_members, collab_messages; billing/entitlement/job/quota tables made server-only.
- `profiles.contact` (email) is no longer readable by other users; others use the `public_profiles` view.
- Existing permissive policies on these tables are dropped first (Postgres ORs permissive policies together).
- Client: `saveRoom` uses UPDATE instead of upsert (so members can edit and host/code stay immutable); room codes use `crypto.getRandomValues`.
- Tests: `scripts/two-user-authz-test.mjs` (storage) and `scripts/two-user-rls-test.mjs` (tables); source assertions added to `scripts/verify-security.mjs`.

## Not verified
- Column names were inferred from client/API code; the repo contains no schema dump. Diff against the real schema before applying.
- `join_room` and `mark_messages_read` definitions are not in the repo. They must be SECURITY DEFINER, use `auth.uid()`, and `join_room` must only insert `(room_code, auth.uid())`. See the verification queries at the end of the RLS migration.
- Nothing was run against Supabase. Apply to staging, run both test scripts with two real accounts, then production.
- Policies that could break features if your schema differs: members editing rooms, post owners deleting others' likes/comments, messages blocked across a block.
- Room codes are a shared secret (8 symbols, ~40 bits) and `join_room` has no rate limit; add one with priority 3.
- No UPDATE policy on likes/messages/comments: edits are not supported.
