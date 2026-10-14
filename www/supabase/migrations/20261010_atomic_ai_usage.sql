-- Tapehead Pro: atomic hourly AI quota reservation.
-- Apply this migration to the connected Supabase project before deploying this build.
-- Each accepted request reserves one allowance immediately; failed upstream attempts
-- still consume an allowance for the hour to prevent abuse/retry storms.

create or replace function public.reserve_ai_usage(p_user_id uuid, p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  used_count integer;
begin
  if p_user_id is null or p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'invalid quota reservation parameters' using errcode = '22023';
  end if;

  -- Serialize reservations for each account across concurrent serverless requests.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select count(*)::integer into used_count
  from public.ai_usage
  where user_id = p_user_id
    and created_at >= now() - interval '1 hour';

  if used_count >= p_limit then
    return false;
  end if;

  insert into public.ai_usage (user_id, created_at)
  values (p_user_id, now());

  return true;
end;
$$;

revoke all on function public.reserve_ai_usage(uuid, integer) from public;
revoke all on function public.reserve_ai_usage(uuid, integer) from anon, authenticated;
grant execute on function public.reserve_ai_usage(uuid, integer) to service_role;
