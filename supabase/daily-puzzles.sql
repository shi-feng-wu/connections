-- Original Disconnections puzzles, written ahead of time and ingested by
-- scripts/ingest-puzzles.mjs. Replaces the NYT read-through cache (`puzzles`)
-- as the app's puzzle source at the content switch; mirrors its shape so the
-- serving code changed minimally. Service-role access only, like `puzzles`.
--
-- Apply once in the Supabase dashboard SQL editor (before the first ingest).
create table if not exists public.daily_puzzles (
  puzzle_date date primary key,
  puzzle_id integer not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.daily_puzzles enable row level security;
-- No policies on purpose: anon/authenticated read nothing; the service-role
-- key (the only reader/writer) bypasses RLS.

-- THE DAY AFTER the first original puzzle serves (once the transition night's
-- recap has gone out — pre-epoch dates bridge from the legacy table until then),
-- retire the stored NYT archive (the last NYT-derived data in our infrastructure):
--   truncate table public.puzzles;
