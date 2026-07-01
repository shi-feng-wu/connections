-- Migration: in-app hints (v1.14.0). Additive and idempotent — safe to run on a live DB.
-- Adds the authoritative hint record (progress.hints) + the scored count (scores.hints_used),
-- then redeploys roster_bundle so the live roster carries hints_used/hints for the score recompute.
-- The canonical definitions live in schema.sql; this is just the delta for an already-provisioned DB.

alter table public.scores   add column if not exists hints_used smallint not null default 0;
alter table public.progress add column if not exists hints      jsonb    not null default '[]'::jsonb;

-- roster_bundle now selects s.hints_used and pr.hints. Re-run the CURRENT definition of
-- public.roster_bundle from supabase/schema.sql after applying the columns above (it's a
-- `create or replace function`, so re-executing that block is all that's needed).
