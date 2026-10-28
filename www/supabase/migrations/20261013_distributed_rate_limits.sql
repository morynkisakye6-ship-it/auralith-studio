-- Auralith Pro: database-side rate limiting (priority 3).
-- The browser talks to Supabase DIRECTLY for messages, comments, follows, room joins etc.,
-- so the API-route limiter (api/security.js + Upstash) cannot protect those paths. These
-- limits run inside Postgres, so they are global across every client and serverless instance.
-- REVIEW + apply to STAGING first. Requires 20261012_database_ownership_rls.sql.

create table if not exists public.rate_limits (
  bucket       text        not null,
  window_start timestamptz not null,
  hits         integer     not null default 0,
  primary key (bucket, window_start)
);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from public, anon, authenticated;

-- Atomic fixed-window counter. Returns true while within the limit.
create or replace function public.rate_limit_hit(p_bucket text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  ws timestamptz;
  n  integer;
begin
  if p_bucket is null or p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'invalid rate limit parameters' using errcode = '22023';
  end if;
  ws := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limits (bucket, window_start, hits) values (p_bucket, ws, 1)
  on conflict (bucket, window_start) do update set hits = public.rate_limits.hits + 1
  returning hits into n;
  -- cheap opportunistic cleanup (~1% of calls)
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '2 days';
  end if;
  return n <= p_limit;
end;
$$;
revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

-- Generic BEFORE INSERT trigger: per-user limit keyed by table. Args: limit, window_seconds.
-- Service-role/internal writes (auth.uid() is null) are not limited.
create or replace function public.enforce_rate_limit()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid;
  lim integer;
  win integer;
begin
  uid := auth.uid();
  if uid is null then return new; end if;
  lim := tg_argv[0]::integer;
  win := tg_argv[1]::integer;
  if not public.rate_limit_hit(tg_table_name || ':' || uid::text, lim, win) then
    raise exception 'rate_limited' using errcode = 'P0001', hint = 'Too many requests. Slow down and try again.';
  end if;
  return new;
end;
$$;
revoke all on function public.enforce_rate_limit() from public, anon, authenticated;

drop trigger if exists rl_messages        on public.messages;
drop trigger if exists rl_comments        on public.comments;
drop trigger if exists rl_collab_messages on public.collab_messages;
drop trigger if exists rl_reports         on public.reports;
drop trigger if exists rl_follows         on public.follows;
drop trigger if exists rl_blocks          on public.blocks;
drop trigger if exists rl_feed_posts      on public.feed_posts;
drop trigger if exists rl_likes           on public.likes;
drop trigger if exists rl_rooms           on public.rooms;
drop trigger if exists rl_room_vocals     on public.room_vocals;

create trigger rl_messages        before insert on public.messages        for each row execute function public.enforce_rate_limit('30',  '60');
create trigger rl_comments        before insert on public.comments        for each row execute function public.enforce_rate_limit('20',  '60');
create trigger rl_collab_messages before insert on public.collab_messages for each row execute function public.enforce_rate_limit('30',  '60');
create trigger rl_reports         before insert on public.reports         for each row execute function public.enforce_rate_limit('10',  '3600');
create trigger rl_follows         before insert on public.follows         for each row execute function public.enforce_rate_limit('60',  '60');
create trigger rl_blocks          before insert on public.blocks          for each row execute function public.enforce_rate_limit('30',  '60');
create trigger rl_feed_posts      before insert on public.feed_posts      for each row execute function public.enforce_rate_limit('20',  '3600');
create trigger rl_likes           before insert on public.likes           for each row execute function public.enforce_rate_limit('120', '60');
create trigger rl_rooms           before insert on public.rooms           for each row execute function public.enforce_rate_limit('10',  '3600');
create trigger rl_room_vocals     before insert on public.room_vocals     for each row execute function public.enforce_rate_limit('10',  '60');
-- NOTE: upserts fire BEFORE INSERT even when they resolve to an update, so frequent upserts count.

-- Room codes are the join secret, so guessing them must be expensive. Clients call this wrapper
-- instead of join_room(); the underlying function is no longer callable directly.
-- Every attempt counts, including failures: errors from join_room are caught in a sub-transaction
-- so the counter increment is NOT rolled back with them.
create or replace function public.join_room_limited(p_room_code text)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  uid uuid := auth.uid();
  result jsonb;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if not public.rate_limit_hit('join_room:' || uid::text, 10, 60)
     or not public.rate_limit_hit('join_room_h:' || uid::text, 60, 3600) then
    raise exception 'rate_limited' using errcode = 'P0001', hint = 'Too many room join attempts.';
  end if;
  begin
    select to_jsonb(public.join_room(p_room_code)) into result;
  exception when others then
    raise warning 'join_room failed: %', sqlerrm;
    return to_jsonb(false);
  end;
  return coalesce(result, to_jsonb(false));
end;
$$;
revoke all on function public.join_room_limited(text) from public, anon;
grant execute on function public.join_room_limited(text) to authenticated;
revoke execute on function public.join_room(text) from public, anon, authenticated;
-- ASSUMPTIONS to verify before applying: join_room(p_room_code text) exists, returns a scalar
-- (boolean/text/uuid), not void/setof. If it returns void, change the wrapper to call it with
-- PERFORM and return to_jsonb(true).
