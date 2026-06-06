-- Membership leaderboard/recap with a per-scope JOIN cutoff (totals AND streaks), plus
-- bot-present recap channels. Run once in the Supabase SQL editor (the MCP is read-only).
-- These definitions also live in schema.sql; this is the standalone migration for an existing
-- DB. No backfill — everything is read-time over existing `scores` / `live_cards`; the "join
-- date" is derived live as min(puzzle_date) per (user, scope).
--
-- MODEL
-- * Membership (who's listed) = users who have FINISHED a game in this scope (this channel for
--   the Channel tab, the whole guild for Server). Not Discord membership.
-- * A listed player's total AND streak count only from their JOIN date for THIS scope (first
--   game here) — so joining starts you at 0 there and your daily results accrue from then,
--   wherever you play them. No newcomer instantly tops a board.
-- * The recap streak is point-in-time membership for the same reason.
-- * recap_channels = channels where the bot is installed and has posted (live_cards).
--
-- user_streak is created first because room_board/room_self call it.

create index if not exists scores_user_idx on public.scores (user_id, puzzle_date);

-- A player's consecutive solve streak; p_since windows it to a join date (null = true global,
-- e.g. a future profile page).
drop function if exists public.user_streak(text);
drop function if exists public.user_streak(text, date);
create or replace function public.user_streak(p_user text, p_since date default null)
returns int
language sql
stable
as $$
  with wins as (
    select distinct puzzle_date as d
    from public.scores
    where user_id = p_user and solved and puzzle_date is not null
      and (p_since is null or puzzle_date >= p_since)
  ),
  grouped as (
    select d, d - (row_number() over (order by d))::int as grp
    from wins
  ),
  last_played as (
    select max(puzzle_date) as d
    from public.scores
    where user_id = p_user and puzzle_date is not null
      and (p_since is null or puzzle_date >= p_since)
  )
  select coalesce(case
    when (select d from last_played) is null then 0
    when not exists (select 1 from wins where d = (select d from last_played)) then 0
    else (
      select count(*)::int from grouped
      where grp = (select grp from grouped order by d desc limit 1)
    )
  end, 0);
$$;
grant execute on function public.user_streak(text, date) to anon, authenticated;

create or replace function public.room_board(
  p_scope text,
  p_since date default null,
  p_limit int default 50,
  p_channel text default null
)
returns table (
  user_id text, name text, avatar text,
  total int, plays int, wins int, win_pct int,
  avg_mistakes float8, streak int
)
language sql
stable
security definer
set search_path = public
as $$
  with mj as (   -- member set + each member's join date for this scope (g: scopes)
    select user_id, min(puzzle_date) as joined
    from public.scores
    where scope_id = p_scope and (p_channel is null or channel_id = p_channel)
    group by user_id
  ),
  agg as (
    select s.user_id,
           (array_agg(s.name   order by s.puzzle_date desc nulls last, s.created_at desc))[1] as name,
           (array_agg(s.avatar order by s.puzzle_date desc nulls last, s.created_at desc))[1] as avatar,
           sum(s.score)::int                          as total,
           count(*)::int                              as plays,
           count(*) filter (where s.solved)::int      as wins,
           round(avg(s.mistakes)::numeric, 1)::float8 as avg_mistakes,
           min(mj.joined)                             as joined
    from public.scores s
    left join mj on mj.user_id = s.user_id
    where (p_since is null or s.puzzle_date >= p_since)
      and case when p_scope like 'g:%'
        then mj.user_id is not null and s.puzzle_date >= mj.joined   -- member, from their join
        else s.scope_id = p_scope and (p_channel is null or s.channel_id = p_channel)
      end
    group by s.user_id
  )
  select a.user_id, a.name, a.avatar, a.total, a.plays, a.wins,
         case when a.plays > 0 then round(100.0 * a.wins / a.plays)::int else 0 end as win_pct,
         a.avg_mistakes,
         case when p_scope like 'g:%'
              then public.user_streak(a.user_id, a.joined)   -- streak windowed to the join too
              else public.current_streak(p_scope, a.user_id, p_channel)
         end as streak
  from agg a
  order by a.total desc, a.plays asc
  limit p_limit;
$$;
grant execute on function public.room_board(text, date, int, text) to anon, authenticated;

drop function if exists public.room_self(text, date, text);
create or replace function public.room_self(
  p_scope text,
  p_since date,
  p_user  text,
  p_channel text default null
)
returns json
language sql
stable
security definer
set search_path = public
as $$
  with mj as (
    select user_id, min(puzzle_date) as joined
    from public.scores
    where scope_id = p_scope and (p_channel is null or channel_id = p_channel)
    group by user_id
  ),
  board as (
    select s.user_id,
           sum(s.score)::int                          as total,
           count(*)::int                              as plays,
           count(*) filter (where s.solved)::int      as wins,
           round(avg(s.mistakes)::numeric, 1)::float8 as avg_mistakes
    from public.scores s
    left join mj on mj.user_id = s.user_id
    where (p_since is null or s.puzzle_date >= p_since)
      and case when p_scope like 'g:%'
        then mj.user_id is not null and s.puzzle_date >= mj.joined
        else s.scope_id = p_scope and (p_channel is null or s.channel_id = p_channel)
      end
    group by s.user_id
  ),
  ranked as (
    select user_id, total, plays, wins, avg_mistakes,
           rank() over (order by total desc) as rk
    from board
  )
  select json_build_object(
    'rank',          (select rk from ranked where user_id = p_user),
    'total_players', (select count(*) from board),
    'total',         coalesce((select total from ranked where user_id = p_user), 0),
    'plays',         coalesce((select plays from ranked where user_id = p_user), 0),
    'wins',          coalesce((select wins  from ranked where user_id = p_user), 0),
    'win_pct',       coalesce((select case when plays > 0 then round(100.0 * wins / plays)::int else 0 end
                        from ranked where user_id = p_user), 0),
    'avg_mistakes',  coalesce((select avg_mistakes from ranked where user_id = p_user), 0),
    'streak',        case when p_scope like 'g:%'
                          then public.user_streak(p_user, (select joined from mj where user_id = p_user))
                          else public.current_streak(p_scope, p_user, p_channel)
                     end
  );
$$;
grant execute on function public.room_self(text, date, text, text) to anon, authenticated;

drop function if exists public.recap_channels();
create or replace function public.recap_channels()
returns table (scope_id text, channel_id text)
language sql
stable
as $$
  select distinct l.scope_id, l.channel_id
  from public.live_cards l
  where l.scope_id like 'g:%' and l.channel_id is not null and l.message_id is not null;
$$;
grant execute on function public.recap_channels() to anon, authenticated;

drop function if exists public.day_results(text, date);
create or replace function public.day_results(p_scope text, p_date date, p_channel text default null)
returns table (
  user_id text, name text, avatar text,
  score int, mistakes int, solved boolean,
  groups_solved smallint, duration_ms int
)
language sql
stable
as $$
  with mj as (
    select user_id, min(puzzle_date) as joined
    from public.scores
    where scope_id = p_scope and (p_channel is null or channel_id = p_channel)
    group by user_id
  )
  select s.user_id, s.name, s.avatar, s.score, s.mistakes,
         s.solved, s.groups_solved, s.duration_ms
  from public.scores s
  left join mj on mj.user_id = s.user_id
  where s.puzzle_date = p_date
    and case when p_scope like 'g:%'
      then mj.user_id is not null and s.puzzle_date >= mj.joined
      else s.scope_id = p_scope and (p_channel is null or s.channel_id = p_channel)
    end
  order by s.solved desc, s.score desc, s.mistakes asc, s.duration_ms asc nulls last;
$$;
grant execute on function public.day_results(text, date, text) to anon, authenticated;

drop function if exists public.room_recap_stats(text, date, date);
create or replace function public.room_recap_stats(
  p_scope text,
  p_since date default null,
  p_date  date default null,
  p_channel text default null
)
returns table (streak int, win_pct int, max_streak int)
language sql
stable
as $$
  with mj as (
    select user_id, min(puzzle_date) as joined
    from public.scores
    where scope_id = p_scope and (p_channel is null or channel_id = p_channel)
    group by user_id
  ),
  days as (
    -- "room day" = any MEMBER solved that day, counted only from that member's join date
    -- (point-in-time, so a new member can't retroactively heal a day before they joined).
    select s.puzzle_date as d, bool_or(s.solved) as solved
    from public.scores s
    left join mj on mj.user_id = s.user_id
    where s.puzzle_date is not null and (p_date is null or s.puzzle_date <= p_date)
      and case when p_scope like 'g:%'
        then mj.user_id is not null and s.puzzle_date >= mj.joined
        else s.scope_id = p_scope and (p_channel is null or s.channel_id = p_channel)
      end
    group by s.puzzle_date
  ),
  wins as (select d from days where solved),
  grouped as (
    select d, d - (row_number() over (order by d))::int as grp
    from wins
  ),
  last_day as (select max(d) as d from days),
  streak as (
    select coalesce(case
      when (select d from last_day) is null then 0
      when not exists (select 1 from wins where d = (select d from last_day)) then 0
      else (select count(*)::int from grouped
            where grp = (select grp from grouped order by d desc limit 1))
    end, 0) as n
  ),
  rate as (
    select case when count(*) > 0
                then round(100.0 * count(*) filter (where solved) / count(*))::int
                else 0 end as pct
    from days
    where (p_since is null or d >= p_since)
  ),
  longest as (
    select coalesce(max(len), 0) as n
    from (select count(*)::int as len from grouped group by grp) islands
  )
  select (select n from streak), (select pct from rate), (select n from longest);
$$;
grant execute on function public.room_recap_stats(text, date, date, text) to anon, authenticated;
