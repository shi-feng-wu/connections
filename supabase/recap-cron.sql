-- Precise daily-recap trigger, run from Supabase instead of (or alongside) the Vercel
-- cron. Vercel Hobby crons only fire "within the hour" — the 2:00 slot landed at 2:55 —
-- whereas pg_cron fires on the exact scheduled minute. pg_net POSTs the recap endpoint,
-- which authorizes off the same `Authorization: Bearer $CRON_SECRET` header Vercel sends,
-- so no app code changes. Safe to keep the Vercel cron too: the recap_posts ledger dedupes,
-- so whichever fires first posts and the other no-ops (handy as a fallback).
--
-- ONE-TIME PREREQUISITE — store the CRON_SECRET in Supabase Vault (keeps it out of git).
-- Run this once in the SQL editor with the SAME value as Vercel's CRON_SECRET env var:
--
--   select vault.create_secret('<your CRON_SECRET value>', 'cron_secret');
--
-- (To rotate later: select vault.update_secret(id, '<new value>') — find id in vault.secrets.)
--
-- SCHEDULE — pg_cron evaluates in UTC and, like Vercel, does NOT follow DST. 0 4 * * * is
-- midnight ET in summer (EDT) / 11pm ET in winter (EST). This matches api/cron-recap.ts's
-- note: bump to '0 5 * * *' at the fall DST change to stay at/after the reset year-round.
-- Re-running this file is safe — cron.schedule upserts by job name.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'daily-recap',
  '0 4 * * *',
  $$
  select net.http_post(
    url     => 'https://connections-olive.vercel.app/api/cron-recap',
    headers => jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'Content-Type',  'application/json'
    ),
    -- pg_net only waits this long for the response; the Vercel function keeps running to
    -- completion regardless, and we don't need the body — this is fire-and-forget.
    timeout_milliseconds => 30000
  );
  $$
);

-- To remove later:  select cron.unschedule('daily-recap');
-- To inspect runs:  select * from cron.job_run_details where jobid =
--                     (select jobid from cron.job where jobname = 'daily-recap')
--                   order by start_time desc limit 10;
