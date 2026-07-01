-- Launch-reliability audit (2026-07-01) follow-up: live_cards cron scans + RPC lockdown.
-- Run in the Supabase SQL editor (or psql) against production. Safe to re-run.
--
-- Background: pg_stat_statements showed the finalize-cards cron (every 2 min) seq-scanning
-- live_cards (~21k rows, mean ~200ms, max 5.4s) because only the PK index exists. Those scans
-- pile up pooler connections; today's log window caught a 9-connection stampede that pushed
-- anon launch-path RPCs (room_board/room_self) into their 3s statement_timeout ceiling.
-- Not the launch bug itself, but a real intermittent degrader of the boot handshake.

-- api/finalize-cards.ts:
--   WHERE interaction_token IS NOT NULL AND message_id IS NOT NULL
--     AND finalized_at IS NULL AND token_at > $1 AND token_at <= $2
CREATE INDEX IF NOT EXISTS live_cards_finalize_scan
  ON public.live_cards (token_at)
  WHERE finalized_at IS NULL AND message_id IS NOT NULL AND interaction_token IS NOT NULL;

-- Second hot cron scan: WHERE message_id IS NOT NULL ORDER BY scope_id (max 1.7s).
CREATE INDEX IF NOT EXISTS live_cards_posted_by_scope
  ON public.live_cards (scope_id)
  WHERE message_id IS NOT NULL;

-- rls_auto_enable() is an event-trigger helper, but EXECUTE was granted to PUBLIC, exposing it
-- as an anon-callable PostgREST RPC (/rest/v1/rpc/rls_auto_enable). Event triggers fire as the
-- function owner regardless of EXECUTE grants, so revoking only removes it from the API surface.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
