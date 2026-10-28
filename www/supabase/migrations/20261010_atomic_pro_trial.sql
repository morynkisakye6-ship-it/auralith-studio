-- Auralith Pro: one-time trial claims protected against concurrent requests.
-- Apply to the correct Supabase project before deploying this build.
-- This table deliberately survives expiration or replacement of an entitlement.

create table if not exists public.pro_trial_claims (
  user_id uuid primary key,
  claimed_at timestamptz not null default now()
);

alter table public.pro_trial_claims enable row level security;
revoke all on table public.pro_trial_claims from public, anon, authenticated;
grant select, insert on table public.pro_trial_claims to service_role;

create or replace function public.claim_pro_trial(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  inserted_count integer;
begin
  if p_user_id is null then
    raise exception 'trial user id is required' using errcode = '22023';
  end if;

  insert into public.pro_trial_claims (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  get diagnostics inserted_count = row_count;
  return inserted_count = 1;
end;
$$;

revoke all on function public.claim_pro_trial(uuid) from public;
revoke all on function public.claim_pro_trial(uuid) from anon, authenticated;
grant execute on function public.claim_pro_trial(uuid) to service_role;
