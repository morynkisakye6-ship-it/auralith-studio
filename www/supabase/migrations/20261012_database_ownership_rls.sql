-- Auralith Pro: database ownership + Row Level Security (priority 2).
-- REVIEW BEFORE APPLYING. Run on a STAGING Supabase project first, then
-- scripts/two-user-rls-test.mjs. Column names were inferred from js/cloud.js and api/*.js
-- because the repo has no schema dump; compare against your real schema first.
-- Run 20261011_private_audio_rls.sql first (defines room_vocals policies).
--
-- IMPORTANT: Postgres ORs permissive policies together, so any old broad policy
-- (e.g. "using (true)") silently defeats the strict ones. Step 1 removes ALL existing
-- policies on the tables below; step 4 recreates only what the app needs.

-- 1. Wipe old policies on app tables -------------------------------------------------
do $$
declare p record;
begin
  for p in
    select schemaname, tablename, policyname from pg_policies
    where schemaname = 'public'
      and tablename in ('profiles','projects','feed_posts','likes','comments','follows','blocks',
                        'reports','messages','rooms','room_members','collab_messages',
                        'pro_entitlements','pro_transactions','tapehead_jobs','ai_usage')
  loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;

-- 2. Enable RLS everywhere ------------------------------------------------------------
alter table public.profiles         enable row level security;
alter table public.projects         enable row level security;
alter table public.feed_posts       enable row level security;
alter table public.likes            enable row level security;
alter table public.comments         enable row level security;
alter table public.follows          enable row level security;
alter table public.blocks           enable row level security;
alter table public.reports          enable row level security;
alter table public.messages         enable row level security;
alter table public.rooms            enable row level security;
alter table public.room_members     enable row level security;
alter table public.collab_messages  enable row level security;
alter table public.pro_entitlements enable row level security;
alter table public.pro_transactions enable row level security;
alter table public.tapehead_jobs    enable row level security;
alter table public.ai_usage         enable row level security;

-- 3. Helpers (security definer so policies don't recurse into RLS) --------------------
create or replace function public.is_room_member(p_code text)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$ select exists (select 1 from public.room_members where room_code = p_code and user_id = auth.uid()); $$;
revoke all on function public.is_room_member(text) from public, anon;
grant execute on function public.is_room_member(text) to authenticated;

create or replace function public.is_blocked_between(a uuid, b uuid)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$ select exists (select 1 from public.blocks
                     where (blocker_id = a and blocked_id = b) or (blocker_id = b and blocked_id = a)); $$;
revoke all on function public.is_blocked_between(uuid, uuid) from public, anon;
grant execute on function public.is_blocked_between(uuid, uuid) to authenticated;

-- 4. Policies -------------------------------------------------------------------------

-- profiles: only the owner reads the full row (it contains `contact`, i.e. email).
-- Everyone else uses the public_profiles view below.
create policy profiles_select_own on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_insert_own on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
-- Column-level lock: clients can only write these columns (blocks self-granting any
-- privileged/billing column you may have added to profiles).
revoke insert, update on public.profiles from anon, authenticated;
grant insert (id, username, contact) on public.profiles to authenticated;
grant update (id, username, contact, avatar_url, bio, location, genres, links, open_to_collab, updated_at)
  on public.profiles to authenticated;

drop view if exists public.public_profiles;
create view public.public_profiles with (security_invoker = false) as
  select id, username, avatar_url, bio, location, genres, links, open_to_collab from public.profiles;
revoke all on public.public_profiles from public;
grant select on public.public_profiles to anon, authenticated;

-- projects: strictly private to the owner.
create policy projects_select_own on public.projects for select to authenticated using (user_id = auth.uid());
create policy projects_insert_own on public.projects for insert to authenticated with check (user_id = auth.uid());
create policy projects_update_own on public.projects for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy projects_delete_own on public.projects for delete to authenticated using (user_id = auth.uid());

-- feed_posts: public to read, owner-only to write.
create policy feed_select_all on public.feed_posts for select to anon, authenticated using (true);
create policy feed_insert_own on public.feed_posts for insert to authenticated with check (user_id = auth.uid());
create policy feed_update_own on public.feed_posts for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy feed_delete_own on public.feed_posts for delete to authenticated using (user_id = auth.uid());

-- likes / comments: public to read; write as yourself; delete your own OR anything on your own post
-- (deleteFeedPost() removes other users' likes/comments before deleting the post).
create policy likes_select_all on public.likes for select to anon, authenticated using (true);
create policy likes_insert_own on public.likes for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.feed_posts f where f.id = post_id));
create policy likes_delete on public.likes for delete to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.feed_posts f where f.id = post_id and f.user_id = auth.uid()));

create policy comments_select_all on public.comments for select to anon, authenticated using (true);
create policy comments_insert_own on public.comments for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.feed_posts f where f.id = post_id));
create policy comments_delete on public.comments for delete to authenticated
  using (user_id = auth.uid() or exists (select 1 from public.feed_posts f where f.id = post_id and f.user_id = auth.uid()));

-- follows: public graph (counts), act only as yourself.
create policy follows_select_all on public.follows for select to anon, authenticated using (true);
create policy follows_insert_own on public.follows for insert to authenticated
  with check (follower_id = auth.uid() and following_id <> auth.uid());
create policy follows_update_own on public.follows for update to authenticated
  using (follower_id = auth.uid()) with check (follower_id = auth.uid());   -- upsert path
create policy follows_delete_own on public.follows for delete to authenticated using (follower_id = auth.uid());

-- blocks: private to the blocker.
create policy blocks_select_own on public.blocks for select to authenticated using (blocker_id = auth.uid());
create policy blocks_insert_own on public.blocks for insert to authenticated
  with check (blocker_id = auth.uid() and blocked_id <> auth.uid());
create policy blocks_update_own on public.blocks for update to authenticated
  using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());   -- upsert path
create policy blocks_delete_own on public.blocks for delete to authenticated using (blocker_id = auth.uid());

-- reports: write-only for users (staff read via dashboard/service role).
create policy reports_insert_own on public.reports for insert to authenticated
  with check (reporter_id = auth.uid() and reported_user_id <> auth.uid());

-- messages: only the two parties read; send only as yourself and not across a block.
-- Read-marking goes through the mark_messages_read RPC; no direct update/delete.
create policy messages_select_parties on public.messages for select to authenticated
  using (sender_id = auth.uid() or recipient_id = auth.uid());
create policy messages_insert_sender on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and recipient_id <> auth.uid()
              and not public.is_blocked_between(sender_id, recipient_id));

-- rooms: members read; host creates and deletes; members may edit (collaboration).
create policy rooms_select_members on public.rooms for select to authenticated
  using (host_id = auth.uid() or public.is_room_member(code));
create policy rooms_insert_host on public.rooms for insert to authenticated with check (host_id = auth.uid());
create policy rooms_update_members on public.rooms for update to authenticated
  using (host_id = auth.uid() or public.is_room_member(code))
  with check (host_id = auth.uid() or public.is_room_member(code));
create policy rooms_delete_host on public.rooms for delete to authenticated using (host_id = auth.uid());

-- Members must not be able to take over a room by rewriting host_id / code.
create or replace function public.rooms_lock_identity() returns trigger language plpgsql as $$
begin
  if new.host_id is distinct from old.host_id or new.code is distinct from old.code then
    raise exception 'room host and code are immutable' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists rooms_lock_identity on public.rooms;
create trigger rooms_lock_identity before update on public.rooms
  for each row execute function public.rooms_lock_identity();

-- room_members: readable by fellow members; joining only through join_room() (security definer);
-- you can leave (delete your own row), nobody can edit or insert directly.
create policy room_members_select on public.room_members for select to authenticated
  using (public.is_room_member(room_code));
create policy room_members_leave_own on public.room_members for delete to authenticated using (user_id = auth.uid());
revoke insert, update on public.room_members from anon, authenticated;

-- collab_messages: members only.
create policy collab_select_members on public.collab_messages for select to authenticated
  using (public.is_room_member(room_code));
create policy collab_insert_member on public.collab_messages for insert to authenticated
  with check (user_id = auth.uid() and public.is_room_member(room_code));

-- 5. Server-only tables (payments, entitlements, jobs, quota) -------------------------
-- No policies = no client access. The API uses the service-role key, which bypasses RLS.
-- This is what stops a user from granting themselves Pro.
revoke all on public.pro_entitlements, public.pro_transactions, public.tapehead_jobs, public.ai_usage
  from anon, authenticated;

-- 6. Verification queries (run after applying; all should be as described) ------------
-- a) Every table below must show rowsecurity = true:
--   select tablename, rowsecurity from pg_tables where schemaname='public' order by 1;
-- b) No leftover permissive policies:
--   select tablename, policyname, cmd, roles, qual from pg_policies where schemaname='public' order by 1,2;
-- c) join_room / mark_messages_read must be SECURITY DEFINER, use auth.uid() (never a client-supplied
--    user id), and join_room must insert ONLY (p_room_code, auth.uid()):
--   select proname, prosecdef, pg_get_functiondef(oid) from pg_proc
--   where proname in ('join_room','mark_messages_read');
