-- Connections leaderboard schema. Idempotent; re-run after scoring changes via
-- Supabase SQL Editor.
-- The Live-tab roster is poll-based (see the `presence` table below), not Realtime
-- Presence. This table backs the per-puzzle board and the season board, scoped to a
-- "room": the Discord guild, or the channel for a DM/group chat (no guild).

create table if not exists public.scores (
  id          bigint generated always as identity primary key,
  puzzle_id   integer     not null,
  puzzle_date date,                          -- for season windowing
  scope_id    text,                          -- guild, or DM/group channel
  user_id     text        not null,
  name        text        not null,
  avatar      text,                          -- Discord avatar URL
  score       integer     not null default 0, -- Game.score
  mistakes    integer     not null default 0,
  solved      boolean     not null default false,
  duration_ms integer,
  created_at  timestamptz not null default now(),
  unique (puzzle_id, user_id)
);

-- Columns added after launch; bring older tables up to date.
alter table public.scores add column if not exists puzzle_date date;
alter table public.scores add column if not exists avatar      text;
alter table public.scores add column if not exists score       integer not null default 0;

-- guild_id generalized to scope_id (guild or DM/group channel). Rename in place
-- on older installs; existing guild ids stay valid as scope ids.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'scores' and column_name = 'guild_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'scores' and column_name = 'scope_id'
  ) then
    alter table public.scores rename column guild_id to scope_id;
  end if;
end $$;
alter table public.scores add column if not exists scope_id text;

-- Per-day groups solved (0-4): partial-completion signal the boolean `solved`
-- can't carry (a loss that cracked 2 groups vs none). Written by /api/score from
-- Game.groupsSolved. Backfill historical wins to 4; past losses' partials are gone.
alter table public.scores add column if not exists groups_solved smallint not null default 0;
update public.scores set groups_solved = 4 where solved and groups_solved = 0;

-- Per-channel dimension. scope_id stays g:<guild> (the server view + all history); channel_id
-- narrows a leaderboard/roster/recap to one channel. Written by /api/score from the launch's
-- channelId. Old rows are NULL → they only ever match the server view, never a channel view
-- (per-channel views are forward-looking; the channel of a historical game isn't recoverable).
alter table public.scores add column if not exists channel_id text;

create index if not exists scores_puzzle_idx on public.scores (puzzle_id, score desc);
create index if not exists scores_season_idx on public.scores (scope_id, puzzle_date);
create index if not exists scores_channel_season_idx on public.scores (scope_id, channel_id, puzzle_date);
-- The membership model looks up a user's scores across all rooms by user_id (+ join-date
-- cutoff), so index that path.
create index if not exists scores_user_idx on public.scores (user_id, puzzle_date);

-- guild_members (a player's full Discord guild list, used to pre-populate the board of
-- every server they belong to) was removed: the server-view board now ranks ONLY players
-- who have actually finished a puzzle in that server, derived straight from scores.scope_id
-- (see room_board / room_self). A listed player's total is still their global cross-server
-- score — only the roster is play-gated, so no one shows on a server they never played in.
-- Dropped so existing DBs converge; harmless on a fresh DB.
drop table if exists public.guild_members;

-- Cumulative per-player totals for one room since a date, highest first.
-- Latest name/avatar (by puzzle date) represents each player.
drop function if exists public.season_standings(text, date, int);
create or replace function public.season_standings(
  p_scope text,
  p_since date,
  p_limit int default 20
)
returns table (user_id text, name text, avatar text, total int, plays int)
language sql
stable
as $$
  select s.user_id,
         (array_agg(s.name   order by s.puzzle_date desc, s.created_at desc))[1] as name,
         (array_agg(s.avatar order by s.puzzle_date desc, s.created_at desc))[1] as avatar,
         sum(s.score)::int as total,
         count(*)::int     as plays
  from public.scores s
  where s.scope_id = p_scope
    and s.puzzle_date >= p_since
  group by s.user_id
  order by total desc, plays asc
  limit p_limit;
$$;

grant execute on function public.season_standings(text, date, int) to anon, authenticated;

-- Room leaderboard: backs the end-screen tabs (this season / all-time). Both
-- aggregate the same `scores` rows over a window the caller picks via p_since
-- (month start for season, NULL for all-time); no new tables. Streak = most-recent
-- consecutive days the player solved; a loss or skipped day ends it (always
-- all-time). Scoped to one room (guild, or DM/group channel).

-- Drop the earlier weekly-named variants, superseded by the windowed pair below.
drop function if exists public.room_week_board(text, date, int);
drop function if exists public.room_week_self(text, date, date, text);

-- Current solve streak for one player in one room (a loss/gap breaks it). p_channel
-- narrows to one channel (null = the whole scope / server view).
drop function if exists public.current_streak(text, text);
create or replace function public.current_streak(p_scope text, p_user text, p_channel text default null)
returns int
language sql
stable
as $$
  with wins as (
    select distinct puzzle_date as d
    from public.scores
    where scope_id = p_scope and user_id = p_user
      and (p_channel is null or channel_id = p_channel)
      and solved and puzzle_date is not null
  ),
  -- islands trick: consecutive dates share one (date - rownum) key, so the
  -- most-recent island's size is the active streak
  grouped as (
    select d, d - (row_number() over (order by d))::int as grp
    from wins
  ),
  last_played as (
    select max(puzzle_date) as d
    from public.scores
    where scope_id = p_scope and user_id = p_user and puzzle_date is not null
      and (p_channel is null or channel_id = p_channel)
  )
  select coalesce(case
    when (select d from last_played) is null then 0
    -- most recent played day must itself be a win, else the streak is broken
    when not exists (select 1 from wins where d = (select d from last_played)) then 0
    else (
      select count(*)::int from grouped
      where grp = (select grp from grouped order by d desc limit 1)
    )
  end, 0);
$$;

grant execute on function public.current_streak(text, text, text) to anon, authenticated;

-- A player's personal solve streak across ALL their daily results (every room), for the
-- membership-mode server board where a score counts wherever it was earned. Mirrors
-- current_streak's islands trick but scope-agnostic — a player has at most one score per
-- date (unique (puzzle_id, user_id)), so their day sequence is unambiguous. p_since windows
-- it to a join date: the board passes each member's per-scope join so the streak shown there
-- counts only from when they joined that room (consistent with the join-date total cutoff);
-- null = the player's true global streak (e.g. a future profile page).
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

-- Leaderboard rows for a window: one per player, richest-first, with every
-- column the end screen shows. p_since NULL = all-time. p_until NULL = up to
-- today; pass a date to rank the board "as of" that day (the daily recap diffs
-- through-yesterday vs through-the-day-before for its rank-change arrows).
drop function if exists public.room_board(text, date, int);
drop function if exists public.room_board(text, date, int, text);
create or replace function public.room_board(
  p_scope text,
  p_since date default null,
  p_limit int default 50,
  p_channel text default null,
  p_until date default null
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
  -- Guild views (g: scope) — Channel OR Server — list everyone who has played in the room
  -- (membership: a score with this scope_id, plus this channel_id for the Channel tab) and
  -- rank them by their total earned in ANY room. So a player's numbers are IDENTICAL on both
  -- tabs; the toggle only changes WHO is listed (this channel's players vs the whole guild's),
  -- never the scores. No one shows on a server/channel they never played in. c: (DM/group)
  -- scopes stay bound to the room a score was earned in. set search_path pins the (security
  -- definer) function for safety.
  with mj as (
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
      and (p_until is null or s.puzzle_date <= p_until)
      and case when p_scope like 'g:%'
        then mj.user_id is not null and s.puzzle_date >= mj.joined
        else s.scope_id = p_scope and (p_channel is null or s.channel_id = p_channel)
      end
    group by s.user_id
  )
  select a.user_id, a.name, a.avatar, a.total, a.plays, a.wins,
         case when a.plays > 0 then round(100.0 * a.wins / a.plays)::int else 0 end as win_pct,
         a.avg_mistakes,
         case when (p_scope like 'g:%')
              then public.user_streak(a.user_id, a.joined)
              else public.current_streak(p_scope, a.user_id, p_channel)
         end as streak
  from agg a
  order by a.total desc, a.plays asc
  limit p_limit;
$$;

grant execute on function public.room_board(text, date, int, text, date) to anon, authenticated;

-- One player's standing for a window as JSON: rank, total players, their stats.
-- Backs the end screen's pinned "your standing" row. p_since NULL = all-time.
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
  -- Mirrors room_board: guild views (Channel or Server) rank the room's members (played here,
  -- plus this channel for the Channel tab) by their total earned in ANY room — identical
  -- numbers across the toggle. c: (DM/group) views stay scope-bound.
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
    'streak',        case when (p_scope like 'g:%')
                          then public.user_streak(p_user, (select joined from mj where user_id = p_user))
                          else public.current_streak(p_scope, p_user, p_channel)
                     end
  );
$$;

grant execute on function public.room_self(text, date, text, text) to anon, authenticated;

-- RLS: the anon key may read the board but never write it. Scores are written
-- only by /api/score via the service role (bypasses RLS), after it verifies
-- identity, replays the game, and computes the score. No anon insert/update
-- policy exists; older ones are dropped below.
alter table public.scores enable row level security;

drop policy if exists "scores readable by all" on public.scores;
create policy "scores readable by all"
  on public.scores for select using (true);

-- drop old client-write policies (the browser used to upsert directly)
drop policy if exists "anyone can insert a score" on public.scores;
drop policy if exists "anyone can update a score" on public.scores;

-- Live updates no longer ride Supabase Realtime: clients can't reliably hold the proxied
-- WebSocket it needs inside a Discord Activity, so the live roster moved to an SSE relay
-- (scripts/relay.mjs on Railway). These old realtime.messages RLS policies are dropped — Supabase
-- is now DB + REST only, with zero realtime traffic.
drop policy if exists "room presence: authenticated read" on realtime.messages;
drop policy if exists "room presence: authenticated write" on realtime.messages;

-- Daily recap plumbing. The bot posts yesterday's results + season standings to the
-- channel an Activity was last played in, per room, on the midnight-ET reset (see
-- /api/cron-recap; the post target is read straight from the scores rows' channel_id).
-- The recap_posts ledger is written only by the service role, which bypasses RLS, so it
-- carries no anon policy (unlike scores there is no "readable by all" grant: the anon
-- key sees nothing here).

-- recap_channels (the legacy webhook.incoming recap target) was removed: the cron now
-- derives the post channel from scores, so nothing read this table. Dropped so existing
-- DBs converge; harmless on a fresh DB.
drop table if exists public.recap_channels;

-- Idempotency ledger: one row per (scope, puzzle_date) once a recap is posted, so
-- a retried or overlapping cron run can't double-post. /api/cron-recap claims a
-- row before posting and treats a unique violation as "already done".
create table if not exists public.recap_posts (
  scope_id    text        not null,
  puzzle_date date        not null,
  posted_at   timestamptz not null default now(),
  primary key (scope_id, puzzle_date)
);

-- Per-channel recaps: channel_id joins the idempotency key so each channel that played
-- gets its own recap per day. Old rows backfill to '' (an empty string can't collide with
-- a real channel snowflake; those past days are never re-posted). Guarded so re-running
-- the schema is a no-op once the PK is already the 3-column shape.
alter table public.recap_posts add column if not exists channel_id text not null default '';
do $$
declare pk_cols text;
begin
  select string_agg(a.attname, ',' order by array_position(c.conkey, a.attnum))
    into pk_cols
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
  where c.conrelid = 'public.recap_posts'::regclass and c.contype = 'p';
  if pk_cols is distinct from 'scope_id,puzzle_date,channel_id' then
    alter table public.recap_posts drop constraint if exists recap_posts_pkey;
    alter table public.recap_posts add constraint recap_posts_pkey primary key (scope_id, puzzle_date, channel_id);
  end if;
end $$;

alter table public.recap_posts enable row level security;

-- Recap opt-out: one row per (scope, channel) a moderator silenced with /unsubscribe, so the
-- daily recap stops posting there. recap_channels() subtracts this set below, so a listed
-- channel drops out of the nightly run even though its live_cards row still exists. It re-arms
-- the moment the Activity is launched in that channel again — postCard (api/interactions.ts)
-- deletes the row when it (re)establishes the "who's playing" card — matching "off until
-- someone starts the activity here again". Written only by the service role (the /unsubscribe
-- handler and postCard); RLS with no policy denies the anon key entirely.
create table if not exists public.recap_optouts (
  scope_id      text        not null,
  channel_id    text        not null,
  opted_out_by  text,                                   -- the user who ran /unsubscribe (audit)
  opted_out_at  timestamptz not null default now(),
  primary key (scope_id, channel_id)
);

alter table public.recap_optouts enable row level security;

-- One row per player for a single puzzle in one room, ranked richest-first
-- (solved before unsolved, then score, fewer mistakes, faster). Backs the daily
-- recap's "yesterday's results" block. Mirrors season_standings' shape/style.
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
  -- Membership-based, like room_board: a guild recap lists this room's MEMBERS (everyone who
  -- has played in this scope, + this channel for a channel recap) who played on p_date, with
  -- each member's one daily game wherever they launched it. c: scopes stay scope-bound.
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

-- Every (guild, channel) where the bot is installed and has posted a card — the set the daily
-- recap fires to, every day. Sourced from live_cards, which only exists where the bot is a
-- guild install (message_id not null = it has actually posted there) — NOT from scores, which
-- also include user-install servers with no bot: those 403 at post time (the vast majority)
-- and spam the run. So a channel with an established habit still gets a card ("nobody got it…
-- new day") on a quiet day, but only where the bot can actually post. g: scopes only.
-- Channels a moderator silenced with /unsubscribe (a recap_optouts row) are subtracted, so the
-- nightly run skips them until the Activity is launched there again (which clears the opt-out).
drop function if exists public.recap_channels();
create or replace function public.recap_channels()
returns table (scope_id text, channel_id text)
language sql
stable
as $$
  select distinct l.scope_id, l.channel_id
  from public.live_cards l
  where l.scope_id like 'g:%' and l.channel_id is not null and l.message_id is not null
    and not exists (
      select 1 from public.recap_optouts o
      where o.scope_id = l.scope_id and o.channel_id = l.channel_id
    );
$$;

grant execute on function public.recap_channels() to anon, authenticated;

-- Room-level header stats for the daily recap, as of a date: the room's current
-- solve streak (consecutive most-recent days at least one player solved), its longest
-- solve streak ever (max_streak), and its season solve rate (% of played days the room
-- solved) over [p_since, p_date]. A "room day" is solved when any player solved that day;
-- both streaks span all history up to p_date (they can cross the season window), while
-- win_pct is windowed by p_since. Mirrors current_streak's islands trick at the room
-- grain — max_streak is just the largest island instead of the most-recent. Backs the recap.
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
    -- (point-in-time: a new member can't retroactively heal a day before they joined).
    select s.puzzle_date as d, bool_or(s.solved) as solved
    from public.scores s
    left join mj on mj.user_id = s.user_id
    where s.puzzle_date is not null
      and (p_date is null or s.puzzle_date <= p_date)
      and case when p_scope like 'g:%'
        then mj.user_id is not null and s.puzzle_date >= mj.joined
        else s.scope_id = p_scope and (p_channel is null or s.channel_id = p_channel)
      end
    group by s.puzzle_date
  ),
  wins as (select d from days where solved),
  -- islands trick: consecutive solve-days share one (date - rownum) key, so the
  -- most-recent island's size is the active room streak
  grouped as (
    select d, d - (row_number() over (order by d))::int as grp
    from wins
  ),
  last_day as (select max(d) as d from days),
  streak as (
    select coalesce(case
      when (select d from last_day) is null then 0
      -- the room's most recent played day must itself be a solve, else the streak broke
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
  -- longest streak ever (to p_date): the biggest island, not just the most-recent one
  longest as (
    select coalesce(max(len), 0) as n
    from (select count(*)::int as len from grouped group by grp) islands
  )
  select (select n from streak), (select pct from rate), (select n from longest);
$$;

grant execute on function public.room_recap_stats(text, date, date, text) to anon, authenticated;

-- Install-nudge throttle: one row per (room, user), bumped each time the launcher of a
-- bot-less server is shown the ephemeral "add the bot for recaps" followup (see
-- /api/interactions). The nudge re-arms after INSTALL_NUDGE_COOLDOWN_MS (a week), so the
-- timestamp is updated in place rather than appended. Written only by the service role;
-- RLS with no policy denies the anon key entirely (same posture as progress/live_cards).
create table if not exists public.install_nudges (
  scope_id  text        not null,
  user_id   text        not null,
  nudged_at timestamptz not null default now(),
  primary key (scope_id, user_id)
);

alter table public.install_nudges enable row level security;

-- In-progress / finished daily state, per player per puzzle: the authoritative
-- record of what a player has actually guessed today. /api/guess appends each
-- guess (commit-then-reveal, so an outcome can't be seen and then abandoned to
-- erase it), /api/start reads it back to resume the exact state on reopen, and
-- /api/score replays it to compute the final score. Because the server owns this
-- list, leaving and relaunching the Activity can't reset mistakes, drop guesses,
-- or re-roll the clock — the "infinite tries" hole. started_at is stamped once via
-- the column default and never written again, so the speed bonus is measured from
-- the real first touch. Written only by the service role; the client never reads
-- it directly (/api/start returns the guesses), so RLS with no policy denies the
-- anon key entirely (same posture as the recap tables above).
create table if not exists public.progress (
  user_id     text        not null,
  puzzle_date date        not null,
  guesses     jsonb       not null default '[]'::jsonb, -- ordered [[w,w,w,w], …]
  started_at  timestamptz not null default now(),       -- pinned on first insert
  updated_at  timestamptz not null default now(),
  primary key (user_id, puzzle_date)
);

-- Read-through cache of the official NYT daily puzzle, one row per date. Backs
-- api/_nyt.ts fetchPuzzle: the first request for a date fetches NYT and upserts here;
-- every later request (any function, any cold start) reads this instead, so NYT — an
-- undocumented endpoint scraped on the game's hot path — is hit ~once per date globally
-- and a NYT outage can't break a day already captured. A puzzle is immutable once
-- published, so rows are never invalidated (no TTL). Written only by the service role;
-- `data` holds the answers (group membership), so like progress/live_cards it carries NO
-- anon policy — RLS with no policy denies the anon key entirely. The client still gets the
-- puzzle through the auth-gated /api/puzzle, never from here.
create table if not exists public.puzzles (
  puzzle_date date        primary key,
  puzzle_id   integer     not null,
  data        jsonb       not null,                 -- normalized Puzzle {id,date,editor,groups,layout}
  fetched_at  timestamptz not null default now()
);

alter table public.puzzles enable row level security;

alter table public.progress enable row level security;

-- Live "who's in the Activity right now" heartbeat, one row per player per day. The
-- Live-tab roster is poll-based (NOT Supabase Realtime presence — that froze when the
-- Activity backgrounded and the socket silently died): each client polls /api/roster every
-- few seconds, and that same call upserts the caller's last_seen here. assembleRoster then
-- marks a player "online" (the green ring) when their last_seen is within the heartbeat TTL.
-- A backgrounded client just stops polling, so it ages out of "online" on its own — there's
-- no long-lived socket to wedge. Written only by the service role (/api/roster); RLS with no
-- policy denies the anon key entirely (same posture as progress/live_cards).
create table if not exists public.presence (
  user_id     text        not null,
  puzzle_date date        not null,
  last_seen   timestamptz not null default now(),
  primary key (user_id, puzzle_date)
);

alter table public.presence enable row level security;

-- "Who's playing today" card, one row per room per puzzle. The card is a BOT message in
-- the channel, posted as a reply to a /connections launch (so it's attributed to the
-- launcher) and edited in place all day (bot messages don't expire). message_id +
-- channel_id locate it. /api/interactions establishes it on the first launch; /api/join
-- (a new player opens the Activity) and /api/refresh-card (a guess) edit it via the bot
-- token. players holds [{id,name,avatar}] for the render (append-only: nobody is removed
-- when they leave). The card only exists where the bot is (a guild install); user-install
-- launches get none. Written only by the service role (RLS, no policy → anon sees nothing).
create table if not exists public.live_cards (
  scope_id    text        not null,
  puzzle_date date        not null,
  message_id  text,                                   -- the bot card message (edited in place); null until a launch posts it
  channel_id  text,                                   -- channel the card lives in (for the bot edit + the reply target)
  players     jsonb       not null default '[]'::jsonb,
  posted_at   timestamptz,                            -- when the current card was first established
  updated_at  timestamptz not null default now(),
  primary key (scope_id, puzzle_date)
);

-- channel_id added when the card moved to a bot message (it needs the channel to edit).
alter table public.live_cards add column if not exists channel_id text;

-- posted_at marks when the current card was established (kept for history).
alter table public.live_cards add column if not exists posted_at timestamptz;

-- edited_at is the last time the card image was written to Discord (establish or live
-- refresh). /api/refresh-card throttles its per-guess edits against it so a flurry of
-- guesses can't spam Discord (a just-finished player bypasses the throttle).
alter table public.live_cards add column if not exists edited_at timestamptz;

-- Legacy: from the earlier interaction-token card (a LAUNCH_ACTIVITY message turned out
-- not to be editable). Unused now that the card is a bot message; retained so old rows load.
alter table public.live_cards add column if not exists interaction_token text;
alter table public.live_cards add column if not exists token_at          timestamptz;

-- Per-channel cards: channel_id joins the key so each channel gets its own "who's playing"
-- card per day (matching the Wordle Activity), instead of one card per guild living in the
-- first channel to launch. The whole reshape — dropping null-channel rows and widening the PK —
-- runs only while the PK is still the old (scope_id, puzzle_date), so replaying the schema is a
-- true no-op once it's widened: nothing is deleted or altered on a re-run.
do $$
declare pk_cols text;
begin
  select string_agg(a.attname, ',' order by array_position(c.conkey, a.attnum))
    into pk_cols
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
  where c.conrelid = 'public.live_cards'::regclass and c.contype = 'p';
  if pk_cols is distinct from 'scope_id,puzzle_date,channel_id' then
    -- A null channel_id is at most today's pre-migration card (ephemeral UI, rebuilt on the next
    -- launch), so it's safe to drop before channel_id becomes a PK member.
    delete from public.live_cards where channel_id is null;
    alter table public.live_cards alter column channel_id set not null;
    alter table public.live_cards drop constraint if exists live_cards_pkey;
    alter table public.live_cards add constraint live_cards_pkey primary key (scope_id, puzzle_date, channel_id);
  end if;
end $$;

alter table public.live_cards enable row level security;

-- Everything one /api/roster poll needs, in a single round-trip. The handler used to make
-- six REST calls per poll (members, card players, then scores/progress/presence + the
-- caller's heartbeat); at a 15s poll per player that was the dominant serverless cost, so
-- this bundles them into one function call. It also dedupes member identity server-side:
-- the old member query returned EVERY score row ever written in the scope (growing with
-- calendar time) just so TS could pick each user's most recent name/avatar — here that's
-- a `distinct on`, one row per member forever.
--
--   members      latest score-row identity per member (ever played in this scope, narrowed
--                to p_channel for the guild Channel view) — the membership model room_board
--                uses, mirrored.
--   card_players raw [{id,name,avatar}] entries from today's live cards (join-time identity;
--                the handler overlays these over members, freshest wins).
--   scores/progress/seen  today's rows for the member ∪ card-opener id set, ANY scope, so a
--                member's single daily game follows them into every room they belong to.
--
-- The caller's presence heartbeat (they're polling, so they're here right now) is stamped
-- in the same trip when p_uid is set. That write makes this volatile and service-role-only:
-- progress.guesses and presence are anon-denied tables (RLS, no policy), so the function
-- must not hand them to anon either — execute is revoked from public below.
drop function if exists public.roster_bundle(text, date, text, text);
create or replace function public.roster_bundle(
  p_scope   text,
  p_date    date,
  p_channel text default null,
  p_uid     text default null
)
returns json
language plpgsql
set search_path = public
as $$
declare
  result json;
begin
  if p_uid is not null then
    insert into public.presence (user_id, puzzle_date, last_seen)
    values (p_uid, p_date, now())
    on conflict (user_id, puzzle_date) do update set last_seen = excluded.last_seen;
  end if;

  with members as (
    select distinct on (user_id) user_id, name, avatar
    from public.scores
    where scope_id = p_scope and (p_channel is null or channel_id = p_channel)
    order by user_id, created_at desc
  ),
  card_players as (
    select p ->> 'id' as user_id, p
    from public.live_cards l, jsonb_array_elements(l.players) as p
    where l.scope_id = p_scope and l.puzzle_date = p_date
      and (p_channel is null or l.channel_id = p_channel)
  ),
  ids as (
    select user_id from members union select user_id from card_players
  )
  select json_build_object(
    'members', coalesce((
      select json_agg(json_build_object('id', m.user_id, 'name', m.name, 'avatar', m.avatar))
      from members m), '[]'::json),
    'card_players', coalesce((select json_agg(c.p) from card_players c), '[]'::json),
    'scores', coalesce((
      select json_agg(json_build_object(
        'user_id', s.user_id, 'name', s.name, 'avatar', s.avatar, 'solved', s.solved,
        'mistakes', s.mistakes, 'groups_solved', s.groups_solved, 'duration_ms', s.duration_ms))
      from public.scores s join ids on ids.user_id = s.user_id
      where s.puzzle_date = p_date), '[]'::json),
    'progress', coalesce((
      select json_agg(json_build_object(
        'user_id', pr.user_id, 'guesses', pr.guesses,
        'started_at', pr.started_at, 'updated_at', pr.updated_at))
      from public.progress pr join ids on ids.user_id = pr.user_id
      where pr.puzzle_date = p_date), '[]'::json),
    'seen', coalesce((
      select json_agg(json_build_object('user_id', se.user_id, 'last_seen', se.last_seen))
      from public.presence se join ids on ids.user_id = se.user_id
      where se.puzzle_date = p_date), '[]'::json)
  ) into result;
  return result;
end $$;

revoke all on function public.roster_bundle(text, date, text, text) from public;
grant execute on function public.roster_bundle(text, date, text, text) to service_role;

-- Player ↔ dev feedback threads. Replaces the old one-shot feedback webhook. Each note a player
-- sends opens its OWN thread (a support ticket), so a player has an inbox of separate
-- conversations — one per feedback — each carrying our replies, rather than one merged stream.
-- chat_threads is one row per ticket (its own id, owned by a Discord user_id); chat_messages are
-- its back-and-forth. Written and read only by the service role (api/chat.ts), which verifies the
-- Discord identity first — a player only ever touches their own tickets, the dev (gated by
-- DEV_DISCORD_IDS) sees all. RLS on with NO policy: anon sees nothing (same posture as
-- progress/presence/live_cards). DISCORD_FEEDBACK_WEBHOOK_URL mirrors both sides (api/_feedback.ts)
-- as a notification — it's no longer the system of record.

-- Feedback tickets, one row per ticket (one-thread-per-feedback). Created if absent and never
-- dropped here, so replaying the schema never wipes a live conversation. (An earlier
-- one-thread-per-player shape was reshaped pre-launch; a dev DB still carrying the old tables —
-- which hold no real data — should be dropped once by hand rather than bake a replayable DROP in.)

-- One feedback ticket. category/subject/puzzle_id capture the opening note (its tag, the
-- player-written title, and the puzzle in play); last_*/read cursors drive ordering and the unread
-- badges, and last_text is the latest line shown beneath the title. Bumped in place as the
-- conversation continues (never appended).
create table if not exists public.chat_threads (
  id                bigint      generated always as identity primary key,
  user_id           text        not null,                 -- the player who opened the ticket
  name              text,                                  -- their latest display identity (for the dev inbox)
  avatar            text,
  category          text,                                  -- 'Bug'|'Idea'|'Other' — the opening note's tag
  subject           text,                                  -- player-written title that names the ticket (the inbox row title)
  puzzle_id         integer,                               -- puzzle in play when the ticket was opened
  last_message_at   timestamptz not null default now(),
  last_sender       text        not null default 'user',  -- 'user' | 'dev' — who sent the latest message
  last_text         text,                                  -- latest message from either side, truncated — the inbox preview line
  user_last_read_at timestamptz not null default now(),   -- player has read this ticket up to here
  dev_last_read_at  timestamptz,                            -- dev has read it up to here (null = never)
  msg_count         integer     not null default 0,
  created_at        timestamptz not null default now()
);

-- player unread  = last_sender = 'dev'  and last_message_at > user_last_read_at
-- dev unread/new  = last_sender = 'user' and (dev_last_read_at is null or last_message_at > dev_last_read_at)
-- A player's inbox lists their tickets newest-active first; the dev inbox orders the same globally.
create index if not exists chat_threads_user_idx on public.chat_threads (user_id, last_message_at desc);
create index if not exists chat_threads_recent_idx on public.chat_threads (last_message_at desc);

alter table public.chat_threads enable row level security;

-- One message in a ticket, oldest-first. author_id/author_name record who actually sent it (the
-- player, or the replying dev). Cascades with its ticket.
create table if not exists public.chat_messages (
  id          bigint      generated always as identity primary key,
  thread_id   bigint      not null references public.chat_threads(id) on delete cascade,
  sender      text        not null check (sender in ('user','dev')),
  author_id   text        not null,
  author_name text,
  text        text        not null,
  created_at  timestamptz not null default now()
);

create index if not exists chat_messages_thread_idx on public.chat_messages (thread_id, created_at);

alter table public.chat_messages enable row level security;
