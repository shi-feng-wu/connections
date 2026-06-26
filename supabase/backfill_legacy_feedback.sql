-- One-time backfill of the pre-threads Discord feedback into the chat inbox.
-- Each old note becomes one thread + one inbound ('user') message, carrying the real Discord
-- user_id so it shows in that player's own Feedback inbox AND your dev Inbox.
--
-- Safe to run: every thread is guarded by NOT EXISTS (user_id, subject), so running this twice
-- inserts nothing the second time. Safe to delete this file afterward.
--
-- Assumptions (tell me if any are wrong and I'll regenerate):
--   • Timestamps are interpreted as US Eastern (-04, EDT) — the app's reference zone.
--   • dev_last_read_at = now() → these do NOT light up your dev inbox as "new". To bring them in
--     as unread instead, set dev_last_read_at = null in each thread insert below.
--   • subject is a short title I derived; the full original wording is kept in the message body.

with t as (
  insert into public.chat_threads
    (user_id, name, category, subject, puzzle_id, last_message_at, last_sender, last_text, user_last_read_at, dev_last_read_at, msg_count)
  select '133012205170982913','train','Idea','Average misses per attempt in stats',1183,
         timestamptz '2026-06-25 16:23:00-04','user',
         $m$In the stats it would be cool to track how many misses per attempt on average each discord member has.

Because not all days are the same difficulty, you can also do an adjusted average based on difficulty, which is measured by the results of all players.$m$,
         timestamptz '2026-06-25 16:23:00-04', now(), 1
  where not exists (select 1 from public.chat_threads where user_id='133012205170982913' and subject='Average misses per attempt in stats')
  returning id
)
insert into public.chat_messages (thread_id, sender, author_id, author_name, text)
select id,'user','133012205170982913','train',
  $m$In the stats it would be cool to track how many misses per attempt on average each discord member has.

Because not all days are the same difficulty, you can also do an adjusted average based on difficulty, which is measured by the results of all players.$m$ from t;

with t as (
  insert into public.chat_threads
    (user_id, name, category, subject, puzzle_id, last_message_at, last_sender, last_text, user_last_read_at, dev_last_read_at, msg_count)
  select '324379980744228865','Andrea','Bug','Game pauses my Spotify on mobile',1183,
         timestamptz '2026-06-25 08:11:00-04','user',
         $m$I'm on mobile and when I play Connections it stops my song on Spotify.$m$,
         timestamptz '2026-06-25 08:11:00-04', now(), 1
  where not exists (select 1 from public.chat_threads where user_id='324379980744228865' and subject='Game pauses my Spotify on mobile')
  returning id
)
insert into public.chat_messages (thread_id, sender, author_id, author_name, text)
select id,'user','324379980744228865','Andrea',
  $m$I'm on mobile and when I play Connections it stops my song on Spotify.$m$ from t;

with t as (
  insert into public.chat_threads
    (user_id, name, category, subject, puzzle_id, last_message_at, last_sender, last_text, user_last_read_at, dev_last_read_at, msg_count)
  select '290085530643857408','Pikashyne','Idea','Better group-chat integration',1183,
         timestamptz '2026-06-25 06:50:00-04','user',
         $m$Better group chat integration like the Wordle one:
message when the activity is start by someone
real time progress indicator (colors only)$m$,
         timestamptz '2026-06-25 06:50:00-04', now(), 1
  where not exists (select 1 from public.chat_threads where user_id='290085530643857408' and subject='Better group-chat integration')
  returning id
)
insert into public.chat_messages (thread_id, sender, author_id, author_name, text)
select id,'user','290085530643857408','Pikashyne',
  $m$Better group chat integration like the Wordle one:
message when the activity is start by someone
real time progress indicator (colors only)$m$ from t;

with t as (
  insert into public.chat_threads
    (user_id, name, category, subject, puzzle_id, last_message_at, last_sender, last_text, user_last_read_at, dev_last_read_at, msg_count)
  select '439596627788038146','AsphyxiAsian','Bug','Summary never posts to our channel',1196,
         timestamptz '2026-06-24 15:31:00-04','user',
         $m$Summary never posts to our channel. Have run command.$m$,
         timestamptz '2026-06-24 15:31:00-04', now(), 1
  where not exists (select 1 from public.chat_threads where user_id='439596627788038146' and subject='Summary never posts to our channel')
  returning id
)
insert into public.chat_messages (thread_id, sender, author_id, author_name, text)
select id,'user','439596627788038146','AsphyxiAsian',
  $m$Summary never posts to our channel. Have run command.$m$ from t;

with t as (
  insert into public.chat_threads
    (user_id, name, category, subject, puzzle_id, last_message_at, last_sender, last_text, user_last_read_at, dev_last_read_at, msg_count)
  select '439596627788038146','AsphyxiAsian','Bug','Hamburger menu covers the countdown',1196,
         timestamptz '2026-06-24 15:30:00-04','user',
         $m$Hamburger menu on top of countdown in bottom right$m$,
         timestamptz '2026-06-24 15:30:00-04', now(), 1
  where not exists (select 1 from public.chat_threads where user_id='439596627788038146' and subject='Hamburger menu covers the countdown')
  returning id
)
insert into public.chat_messages (thread_id, sender, author_id, author_name, text)
select id,'user','439596627788038146','AsphyxiAsian',
  $m$Hamburger menu on top of countdown in bottom right$m$ from t;

with t as (
  insert into public.chat_threads
    (user_id, name, category, subject, puzzle_id, last_message_at, last_sender, last_text, user_last_read_at, dev_last_read_at, msg_count)
  select '133012205170982913','train','Idea','Share option outside Discord',1194,
         timestamptz '2026-06-23 09:31:00-04','user',
         $m$It would be nice to have a share option for outside of discord. For example sharing via text message.$m$,
         timestamptz '2026-06-23 09:31:00-04', now(), 1
  where not exists (select 1 from public.chat_threads where user_id='133012205170982913' and subject='Share option outside Discord')
  returning id
)
insert into public.chat_messages (thread_id, sender, author_id, author_name, text)
select id,'user','133012205170982913','train',
  $m$It would be nice to have a share option for outside of discord. For example sharing via text message.$m$ from t;

with t as (
  insert into public.chat_threads
    (user_id, name, category, subject, puzzle_id, last_message_at, last_sender, last_text, user_last_read_at, dev_last_read_at, msg_count)
  select '789980155845541888','picto','Other','this game is ratshit',1194,
         timestamptz '2026-06-23 15:40:00-04','user',
         $m$this game is ratshit$m$,
         timestamptz '2026-06-23 15:40:00-04', now(), 1
  where not exists (select 1 from public.chat_threads where user_id='789980155845541888' and subject='this game is ratshit')
  returning id
)
insert into public.chat_messages (thread_id, sender, author_id, author_name, text)
select id,'user','789980155845541888','picto',
  $m$this game is ratshit$m$ from t;

-- Confirmation: the backfilled inbox, newest first.
select id, name, category, subject, puzzle_id, last_message_at
from public.chat_threads
order by last_message_at desc;
