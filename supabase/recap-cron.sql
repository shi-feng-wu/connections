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
-- Replace YOUR-DEPLOYMENT below with your real Vercel host before running.
--
-- (To rotate later: select vault.update_secret(id, '<new value>') — find id in vault.secrets.)
--
-- SCHEDULE — pg_cron evaluates in UTC and does NOT follow DST, but the Connections reset is
-- fixed at midnight ET, whose UTC time shifts with DST: 04:00 UTC in summer (EDT), 05:00 UTC
-- in winter (EST). So we register TWO jobs, at 04:00 and 05:00 UTC, ~1h apart. In every
-- season at least one fires at/after the true midnight ET — by which point today's puzzle is
-- published and yesterday's day is complete, so the handler's todayET()/yesterdayET() and its
-- puzzle-warm are correct. The redundant run is harmless: api/cron-recap.ts claims a
-- recap_posts ledger row before posting (no double-post) and the puzzle fetch is cache-backed
-- (no double NYT call). This replaces the old single-row job that needed a manual seasonal
-- bump and skipped a day at the spring-forward transition. Re-running this file is safe —
-- cron.schedule upserts by job name.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Drop the legacy single-row job if it's still registered. unschedule(jobid) matches zero
-- rows without raising; unschedule('name') would error when the job is absent.
select cron.unschedule(jobid) from cron.job where jobname = 'daily-recap';

select cron.schedule(
  'daily-recap-a',
  '0 4 * * *',
  $$
  select net.http_post(
    url     => 'https://YOUR-DEPLOYMENT.vercel.app/api/cron-recap',
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

select cron.schedule(
  'daily-recap-b',
  '0 5 * * *',
  $$
  select net.http_post(
    url     => 'https://YOUR-DEPLOYMENT.vercel.app/api/cron-recap',
    headers => jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'Content-Type',  'application/json'
    ),
    timeout_milliseconds => 30000
  );
  $$
);

-- To remove later:  select cron.unschedule('daily-recap-a'); select cron.unschedule('daily-recap-b');
-- To inspect runs:  select * from cron.job_run_details where jobid in
--                     (select jobid from cron.job where jobname like 'daily-recap%')
--                   order by start_time desc limit 10;
