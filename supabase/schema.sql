-- Connections leaderboard schema. Idempotent; re-run after scoring changes via
-- Supabase SQL Editor.
-- Presence needs no table (Realtime Presence is built in). This table backs the
-- per-puzzle board and the season board, scoped to a "room": the Discord guild,
-- or the channel for a DM/group chat (no guild).

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

-- Leaderboard rows for a window: one per player, richest-first, with every
-- column the end screen shows. p_since NULL = all-time.
drop function if exists public.room_board(text, date, int);
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
as $$
  with agg as (
    select s.user_id,
           (array_agg(s.name   order by s.puzzle_date desc nulls last, s.created_at desc))[1] as name,
           (array_agg(s.avatar order by s.puzzle_date desc nulls last, s.created_at desc))[1] as avatar,
           sum(s.score)::int                          as total,
           count(*)::int                              as plays,
           count(*) filter (where s.solved)::int      as wins,
           round(avg(s.mistakes)::numeric, 1)::float8 as avg_mistakes
    from public.scores s
    where s.scope_id = p_scope
      and (p_channel is null or s.channel_id = p_channel)
      and (p_since is null or s.puzzle_date >= p_since)
    group by s.user_id
  )
  select a.user_id, a.name, a.avatar, a.total, a.plays, a.wins,
         case when a.plays > 0 then round(100.0 * a.wins / a.plays)::int else 0 end as win_pct,
         a.avg_mistakes,
         public.current_streak(p_scope, a.user_id, p_channel) as streak
  from agg a
  order by a.total desc, a.plays asc
  limit p_limit;
$$;

grant execute on function public.room_board(text, date, int, text) to anon, authenticated;

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
as $$
  with board as (
    select user_id,
           sum(score)::int                          as total,
           count(*)::int                            as plays,
           count(*) filter (where solved)::int      as wins,
           round(avg(mistakes)::numeric, 1)::float8 as avg_mistakes
    from public.scores
    where scope_id = p_scope
      and (p_channel is null or channel_id = p_channel)
      and (p_since is null or puzzle_date >= p_since)
    group by user_id
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
    'streak',        public.current_streak(p_scope, p_user, p_channel)
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

-- Realtime authorization for live presence. Room channels are private; a holder
-- of a server-minted Supabase JWT (/api/realtime-token, from a verified Discord
-- identity) may join/broadcast only in the room named by its `room` claim. The
-- policy pins topic = 'room:' || claim, so a token for one room can't touch any
-- other (a plain `like 'room:%'` would let any authenticated user join every
-- room). Blocks anonymous spoofing and cross-room snooping. Needs Realtime
-- Authorization (RLS on realtime.messages). Dev clients with no JWT use a public
-- channel.
drop policy if exists "room presence: authenticated read" on realtime.messages;
create policy "room presence: authenticated read"
  on realtime.messages for select to authenticated
  using ( realtime.topic() = 'room:' || (auth.jwt() ->> 'room') );

drop policy if exists "room presence: authenticated write" on realtime.messages;
create policy "room presence: authenticated write"
  on realtime.messages for insert to authenticated
  with check ( realtime.topic() = 'room:' || (auth.jwt() ->> 'room') );

-- Daily recap plumbing. The bot posts yesterday's results + season standings to
-- the channel an Activity was last played in, per room, on the midnight-ET reset
-- (see /api/cron-recap). Both tables are written only by the service role, which
-- bypasses RLS, so neither carries an anon policy (unlike scores there is no
-- "readable by all" grant: the anon key sees nothing here).

-- Where to post a room's recap. scope_id mirrors public.scores.scope_id (g:<guild>
-- or c:<channel>). channel_id is the post target: the channel the room last played in,
-- upserted by /api/score (for a g: scope it is NOT recoverable from scope_id, which
-- holds the guild id). /api/cron-recap posts the recap there as the app's bot user
-- (added when an admin chooses "Add to Server"), mirroring Wordle's daily summary. A
-- room with no channel_id (nobody has finished a game there) gets no recap.
--
-- webhook_id/webhook_url are legacy, from the earlier webhook.incoming install flow;
-- the bot-posting cron no longer reads them. Kept so old rows don't error.
create table if not exists public.recap_channels (
  scope_id    text        primary key,
  channel_id  text        not null,
  guild_id    text,
  webhook_id  text,                          -- legacy (webhook.incoming install); unused
  webhook_url text,                          -- legacy (webhook.incoming install); unused
  updated_at  timestamptz not null default now()
);

-- Legacy columns from the incoming-webhook recap; retained so older installs still load.
alter table public.recap_channels add column if not exists webhook_id  text;
alter table public.recap_channels add column if not exists webhook_url text;

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

alter table public.recap_channels enable row level security;
alter table public.recap_posts    enable row level security;

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
  select s.user_id, s.name, s.avatar, s.score, s.mistakes,
         s.solved, s.groups_solved, s.duration_ms
  from public.scores s
  where s.scope_id = p_scope and s.puzzle_date = p_date
    and (p_channel is null or s.channel_id = p_channel)
  order by s.solved desc, s.score desc, s.mistakes asc, s.duration_ms asc nulls last;
$$;

grant execute on function public.day_results(text, date, text) to anon, authenticated;

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
  with days as (
    select s.puzzle_date as d, bool_or(s.solved) as solved
    from public.scores s
    where s.scope_id = p_scope
      and (p_channel is null or s.channel_id = p_channel)
      and s.puzzle_date is not null
      and (p_date is null or s.puzzle_date <= p_date)
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

alter table public.progress enable row level security;

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
-- first channel to launch. A row with a null channel_id is at most today's pre-migration
-- card (ephemeral UI, rebuilt on the next launch), so it's safe to drop before channel_id
-- becomes a PK member. Guarded so re-running the schema is a no-op once the PK is widened.
delete from public.live_cards where channel_id is null;
do $$
declare pk_cols text;
begin
  select string_agg(a.attname, ',' order by array_position(c.conkey, a.attnum))
    into pk_cols
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
  where c.conrelid = 'public.live_cards'::regclass and c.contype = 'p';
  if pk_cols is distinct from 'scope_id,puzzle_date,channel_id' then
    alter table public.live_cards alter column channel_id set not null;
    alter table public.live_cards drop constraint if exists live_cards_pkey;
    alter table public.live_cards add constraint live_cards_pkey primary key (scope_id, puzzle_date, channel_id);
  end if;
end $$;

alter table public.live_cards enable row level security;
