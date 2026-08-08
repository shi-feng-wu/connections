-- Perf support for scripts/dashboard.mjs (paste into the Supabase SQL editor).
-- The dashboard works without this; running it makes the 30s background refresh
-- cheap for the database instead of a pair of full-table sorts per poll.

-- Time-cursor indexes for the dashboard's incremental fetches ("rows since the
-- high-water mark"). Plain CREATE INDEX (not CONCURRENTLY, which the SQL editor's
-- transaction wrapper rejects): expect a write lock of a second or two per table.
create index if not exists scores_created_idx on public.scores (created_at);
create index if not exists progress_started_idx on public.progress (started_at);

-- One-scan aggregate for the card KPIs. Replaces the dashboard's client-side dump
-- of live_cards (130k+ rows over ~134 REST pages every 5 minutes); the dashboard
-- probes for this function and falls back to the old dump until it exists.
create or replace function public.dashboard_card_stats()
returns table (cards_posted bigint, card_servers bigint)
language sql
stable
set search_path = ''
as $$
  select count(*) filter (where message_id is not null),
         count(distinct scope_id) filter (where message_id is not null and scope_id like 'g:%')
  from public.live_cards;
$$;

-- Service-role only: admin telemetry, not app surface.
revoke execute on function public.dashboard_card_stats() from public, anon, authenticated;
grant execute on function public.dashboard_card_stats() to service_role;
