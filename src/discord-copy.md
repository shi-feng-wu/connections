<!--
  Every message the bot posts to Discord, in one place. EDIT THE WORDING HERE.

  Format (parsed by scripts/discord-copy-parse.mjs): each message is a "## key" header followed by
  its text. A message can span multiple lines (e.g. a "-#" small-print line on its own line). Blank
  lines between sections are ignored. {placeholders} are filled in by code at send time — keep them
  spelled exactly. Discord markdown works in the text itself: **bold**, `code`, and "-# " for the
  small grey sub-line.

  After editing, run `npm run gen:copy` to refresh src/discord-copy.ts (the build does this too; a
  test fails if they drift). Keep messages brief and casual, like a real chat message — go easy on
  em dashes.
-->

## donate

Disconnections is ad-free. Donations help cover the server costs. Any amount helps, thank you!

## enable-posts.already

Posts are already on for this channel, so the live card and nightly recap should show up here.
-# Not seeing them? Check the bot has View Channel, Send Messages, and Attach Files in this channel.

## enable-posts.reenabled

Posts are back on for this channel. The live card and nightly recap will show up here again.

## enable-posts.need-perms

Posts are off in this channel, and turning them back on needs the Manage Channels permission. Ask a mod to run `/unmute` here.

## unmute.botless-on

Posts are on in this channel. The who’s playing card shows up when someone launches, and yesterday’s recap lands on the first launch of the day.
-# [Invite the bot]({url}) and the card updates all day, plus recaps arrive at midnight automatically.

## unmute.botless-reenabled

Posts are back on in this channel: the who’s playing card, and yesterday’s recap on the first launch of the day.
-# [Invite the bot]({url}) and the card updates all day, plus recaps arrive at midnight automatically.

## invite-bot

Here’s the invite link for the Disconnections bot.
-# With the bot in the server, the who’s playing card updates all day and recaps arrive at midnight automatically. Adding it needs the Manage Server permission.

## help

Disconnections commands:
`/disconnections` launches the daily puzzle. `/connections` does the same.
`/share` posts your result grid for today’s puzzle.
`/donate` helps cover the server costs.
`/invite-bot` adds the Disconnections bot to this server.
`/mute` (mods) stops the cards and recaps in this channel.
`/unmute` (mods) turns them back on here.
`/help` shows this list.

## missing-perms

I’m in this server but can’t post in this channel, so the card and recap won’t show up here.
Give the Disconnections bot these permissions on this channel: View Channel, Send Messages, Attach Files.
-# Usually it’s a private channel the bot’s role isn’t in. Check the channel’s Permissions.

## disable-posts.done

Posts are off for this channel now, no who’s playing card and no recaps. Run `/unmute` here to turn them back on.
-# People can still play; this only mutes what Disconnections posts.

## disable-posts.already

Posts are already off for this channel. Run `/unmute` here to turn them back on.

## disable-posts.no-guild

`/mute` only works in a server channel, since that’s the only place Disconnections posts.

## disable-posts.error

Couldn’t update posts just now. Try `/mute` again in a moment.

## share.no-account

Couldn’t read your Discord account. Try again?

## share.unavailable

Sharing’s down right now. Try again in a bit.

## share.not-played

You haven’t played today’s Disconnections yet. Run `/disconnections`, then `/share` your grid.

## share.load-failed

Couldn’t load today’s puzzle. Try `/share` again in a moment.

## share.mid-puzzle

Still mid-puzzle: {solved}/4 groups, {mistakes} left. Finish it, then `/share`.

## share.build-failed

Couldn’t build your share. Try `/share` again.

## reply-dm.subject

Re: {subject}

## reply-dm.subject-blank

Re: your feedback

## reply-dm.context-label

You wrote

## reply-dm.footer

Open Disconnections to reply

## unsupported

Sorry, I can’t handle that one.

## button.play

Play now!

## button.add-server

Add to Server

## button.donate

Donate on Ko-fi

## card.playing

{subject} {verb} playing!

## recap.tail

Here are yesterday's results:

## recap.streak

**Your group is on a {streak} day streak! {fires}** {tail}

## recap.broken-prefix

**{broken}-day streak broken!**

## recap.stumped

Yesterday's {puzzle} stumped everyone

## recap.no-play

Nobody played yesterday's {puzzle}

## recap.new-day

… but today is a new day 🌞

## recap.invite-aside

-# (btw: [invite the bot]({url}) and the who’s playing card updates all day, plus recaps arrive at midnight automatically)
