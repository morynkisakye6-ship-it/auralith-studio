-- Tapehead Pro: private audio authorization (priority 1).
-- REVIEW BEFORE APPLYING. Apply to a preview/staging Supabase project first and run
-- scripts/two-user-authz-test.mjs. Assumes these existing tables/columns (not in repo):
--   room_members(room_code text, user_id uuid)
--   room_vocals(room_code text, user_id uuid, file_path text, file_url text, username text, created_at)
-- If your column names differ, adjust below. Upload path convention: <user_id>/<ROOM>_<ts>_<name>

-- 1. Bucket must be private, size/type limited server-side (client checks are bypassable).
update storage.buckets
set public = false,
    file_size_limit = 26214400,
    allowed_mime_types = array['audio/webm','audio/wav','audio/x-wav','audio/mpeg','audio/mp4','audio/ogg','audio/aac']
where id = 'vocals';

-- 2. Remove any broad legacy policies on this bucket so only the ones below apply.
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (coalesce(qual,'') ilike '%vocals%' or coalesce(with_check,'') ilike '%vocals%')
  loop
    execute format('drop policy %I on storage.objects', p.policyname);
  end loop;
end $$;

-- 3. Helper: is the caller a member of the room that owns this vocal object?
create or replace function public.can_read_vocal(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.room_vocals rv
    join public.room_members rm on rm.room_code = rv.room_code
    where rv.file_path = p_name
      and rm.user_id = auth.uid()
  );
$$;
revoke all on function public.can_read_vocal(text) from public, anon;
grant execute on function public.can_read_vocal(text) to authenticated;

-- 4. Storage policies. No UPDATE policy on purpose: objects are immutable (no overwrite).
create policy "vocals_insert_own_folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'vocals' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "vocals_select_own_or_room_member" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'vocals'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.can_read_vocal(name))
  );

create policy "vocals_delete_own_folder" on storage.objects
  for delete to authenticated
  using (bucket_id = 'vocals' and (storage.foldername(name))[1] = auth.uid()::text);

-- 5. room_vocals metadata RLS.
alter table public.room_vocals enable row level security;

drop policy if exists room_vocals_select_members on public.room_vocals;
drop policy if exists room_vocals_insert_own on public.room_vocals;
drop policy if exists room_vocals_delete_own on public.room_vocals;

create policy room_vocals_select_members on public.room_vocals
  for select to authenticated
  using (exists (select 1 from public.room_members rm
                 where rm.room_code = room_vocals.room_code and rm.user_id = auth.uid()));

create policy room_vocals_insert_own on public.room_vocals
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and file_path like auth.uid()::text || '/%'
    and exists (select 1 from public.room_members rm
                where rm.room_code = room_vocals.room_code and rm.user_id = auth.uid())
  );

create policy room_vocals_delete_own on public.room_vocals
  for delete to authenticated
  using (user_id = auth.uid());
-- No UPDATE policy: rows are replaced via delete+insert.

revoke all on public.room_vocals from anon;
