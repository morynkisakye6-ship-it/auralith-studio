# Tapehead Pro v1.12.15 release runbook

Do the steps in order. Do not skip staging. Every step has a check; if a check fails, stop and use the rollback notes at the end.
Nothing in this bundle has been run against your real Supabase, Upstash, Vercel or Pesapal accounts.

## 0. Before you touch anything (15 min)
1. Back up production: Supabase dashboard > Database > Backups (take a manual backup). Note the time.
2. Create a **new, separate Supabase project** named `tapehead-staging` (never reuse a project that belongs to another app). Write down its reference id (the `xxxx` in `https://xxxx.supabase.co`) and put it next to the name of every other project in a note, so you can tell them apart. **Before pasting any SQL, read the project name in the top bar of the SQL editor.** Then create a **staging Supabase project** (a copy of production's schema; "Branching" or a fresh project restored from a schema-only dump: `pg_dump --schema-only`).
3. Read these definitions in staging and production SQL editor and confirm the results:
   ```sql
   select proname, prosecdef, pg_get_functiondef(oid) from pg_proc
   where proname in ('join_room','mark_messages_read','claim_pro_trial','reserve_ai_usage');
   ```
   - `join_room(p_room_code text)` must be `SECURITY DEFINER`, use `auth.uid()` (never a client-supplied user id), insert only `(room_code, auth.uid())`, and **return a single value** (boolean/text/uuid), not `void`/`setof`. If it returns `void`, edit the wrapper at the end of `20261013_...sql` as noted there.
   - `mark_messages_read` must also be `SECURITY DEFINER` and filter on `auth.uid()`.
4. Confirm these column names exist (the RLS migration assumes them): `room_members(room_code, user_id)`, `room_vocals(room_code, user_id, file_path, file_url, username)`, `rooms(code, host_id)`, `messages(sender_id, recipient_id)`, `blocks(blocker_id, blocked_id)`, `follows(follower_id, following_id)`, `reports(reporter_id, reported_user_id)`, `likes/comments(post_id, user_id)`, `profiles(id, username, contact, avatar_url, bio, location, genres, links, open_to_collab)`. If any differ, fix the SQL before running it.
5. Confirm the 12 icon PNGs listed in `manifest.webmanifest` exist in the repo.

## 1. Staging: database (30 min)
Run in order in the staging SQL editor, one file at a time:
1. `supabase/migrations/20261011_private_audio_rls.sql`
2. `supabase/migrations/20261012_database_ownership_rls.sql`
3. `supabase/migrations/20261013_distributed_rate_limits.sql`

Checks:
```sql
select tablename, rowsecurity from pg_tables where schemaname='public' order by 1;   -- app tables all true
select tablename, policyname, cmd, roles from pg_policies where schemaname='public' order by 1,2;  -- nothing using (true) on private tables
select id, public, file_size_limit from storage.buckets where id='vocals';           -- public = false
```

## 2. Staging: accounts and live tests (20 min)
1. In staging create 3 confirmed users (A, B, C) with passwords.
2. Run both scripts (never against production; each prints PASS/FAIL per check):
   ```bash
   cd www && npm i --no-save @supabase/supabase-js
   export STAGING_SUPABASE_REF=<staging ref> SUPABASE_URL=https://<staging ref>.supabase.co SUPABASE_ANON_KEY=... USER_A_EMAIL=... USER_A_PASSWORD=... USER_B_EMAIL=... USER_B_PASSWORD=... USER_C_EMAIL=... USER_C_PASSWORD=...
   node scripts/two-user-authz-test.mjs     # private audio
   node scripts/two-user-rls-test.mjs       # tables, billing tables, rate limits
   ```
3. **Every check must PASS.** A FAIL means a policy or column differs from what was assumed: fix the migration in staging, rerun from step 1 on a fresh staging copy.

## 3. Rate-limit store (10 min)
1. Create an Upstash Redis database (free tier is enough) in the region nearest your Vercel functions.
2. Vercel > Project > Settings > Environment Variables (Preview first, Production later): `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (the Vercel/Upstash integration's `KV_REST_API_URL`/`KV_REST_API_TOKEN` also work).
3. Existing variables must still be set: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PESAPAL_CONSUMER_KEY`, `PESAPAL_CONSUMER_SECRET`, `PESAPAL_ENV`, `PESAPAL_IPN_ID`, `PUBLIC_APP_URL`, `OPENAI_API_KEY`, and a long random `JOBS_PROCESS_SECRET` (or `CRON_SECRET`).

## 4. CI gate (15 min)
1. Commit the repo contents (workflow at `.github/workflows/security.yml`; if your repo root is `www`, move it as its header comment says). Confirm `www/.vercelignore` is in the Vercel project root.
2. GitHub > Settings > Secrets and variables > Actions: add `STAGING_SUPABASE_REF`, `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_ANON_KEY`, `STAGING_USER_{A,B,C}_{EMAIL,PASSWORD}`.
3. GitHub > Settings > Branches > rule for `main`: require status checks `offline` and `e2e-mobile` (and `live-staging` once it has passed once).
4. Vercel > Settings > Git: enable "Require checks to pass before deploying" if available.
5. Push a branch and open a PR: `offline` and `e2e-mobile` must go green (about 3 and 5 minutes). Merge to `main` once: `live-staging` runs and must be green.
6. Locally, the same gate: `node scripts/verify-security.mjs && node scripts/test-limiter.mjs && node --test tests/*.test.mjs && node --test --test-concurrency=1 e2e/*.e2e.mjs` (last needs Playwright).

## 5. Real-device pass on a Preview deployment (45 min per device)
Point the Preview deployment at **staging** Supabase and work through `qa/MOBILE-QA-CHECKLIST.md` on at least one iPhone and one Android phone. No open S1/S2.

## 6. Production rollout
**Order matters: database first, then app.** The 1.12.13 app calls `join_room_limited`; the database migration revokes direct access to `join_room`, so an old cached app that still calls `join_room` fails to join rooms until it refreshes.
1. Pick a quiet time. Announce a short maintenance window if you have active collaboration users.
2. Production SQL editor: run the three migrations in order (same as step 1). Run the three check queries.
3. Immediately deploy `main` to production (Vercel). The service worker updates installed apps on next launch (cache `tapehead-v11215-bugfix`).
4. Add the Upstash variables to **Production** and redeploy once more if they were Preview-only.
5. Smoke test (10 min) with a real test account on a phone:
   - sign in; open Studio; Play makes sound; Record 5 s; Send to Mix; Bounce Full Mix downloads a playable WAV; repeat with Master = Streaming (louder, report shows about -14 LUFS) and Format = MP3 while online (plays in the phone's music app)
   - create a room; copy the code; join from a second device; upload a vocal; the second device hears it; Leave works
   - Pro status loads; (optional, sandbox) start a checkout and confirm the Pesapal redirect appears
   - Vercel logs: no `distributed limiter unavailable`; Upstash dashboard shows commands arriving
6. Watch for 24 hours: Vercel function errors and 429 rates, Supabase logs for `rate_limited` or `42501` (RLS denials), Upstash command count, support messages. A burst of 42501 errors from legitimate users means a policy is too strict.

## 7. Rollback
- **App only:** Vercel > Deployments > promote the previous deployment. The old app still works with the new database **except** room joining (it calls `join_room`). Quick fix: `grant execute on function public.join_room(text) to authenticated;`
- **Rate limits too strict:** `alter table public.rooms disable trigger rl_rooms;` (same pattern for `rl_messages`, `rl_comments`, `rl_collab_messages`, `rl_reports`, `rl_follows`, `rl_blocks`, `rl_feed_posts`, `rl_likes`, `rl_room_vocals`). Raise the numbers later by recreating the trigger with new arguments.
- **A policy blocks a real feature:** do not disable RLS on a table. Find the failing call in Supabase logs, then add or fix that one policy. Emergency only, per table: `alter table public.<t> disable row level security;`, and never for `profiles`, `messages`, `projects`, `room_members`, `room_vocals`, or the payment tables. The `vocals` bucket must stay private.
- **Database:** restore the manual backup from step 0 only as a last resort; it loses writes made since.

## 8. After release
- Complete `qa/MOBILE-QA-CHECKLIST.md` sign-off and keep the filled copy with the release.
- Decide on the MP3 option (build only produces WAV) and add an Auth CAPTCHA plus Supabase Auth rate limits in the dashboard (not covered by this code).
- Rotate any test-account passwords used for staging and keep staging credentials out of production.
