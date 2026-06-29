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

Connections is ad-free. Donations help cover the server costs. Any amount helps, thank you!

## enable-posts.add-bot

Add the bot and it’ll drop a nightly recap in this channel. It also extends how long it can edit the who’s playing card for.
-# Adding it needs the Manage Server permission.

## enable-posts.already

The bot’s already in this server, so the nightly recap should post here at reset.
-# Not seeing it? Check it has View Channel, Send Messages, and Attach Files in this channel.

## install-nudge

Add the bot to extend how long it can edit the who’s playing card, plus a nightly recap when the puzzle resets.
-# Needs the Manage Server permission. Not an admin? Ask one to run `/enable-posts`.

## missing-perms

I’m in this server but can’t post in this channel, so the card and recap won’t show up here.
Give the Connections bot these permissions on this channel: View Channel, Send Messages, Attach Files.
-# Usually it’s a private channel the bot’s role isn’t in. Check the channel’s Permissions.

## unsubscribe.done

Recaps are off for this channel now. They’ll come back automatically if someone launches Connections here again.
-# To mute them for good, take away the bot’s View Channel permission here.

## unsubscribe.already

Recaps are already off here. They’ll come back if someone launches Connections in this channel again.

## unsubscribe.no-guild

`/unsubscribe` only works in a server channel, since that’s the only place recaps post.

## unsubscribe.error

Couldn’t update recaps just now. Try `/unsubscribe` again in a moment.

## share.no-account

Couldn’t read your Discord account. Try again?

## share.unavailable

Sharing’s down right now. Try again in a bit.

## share.not-played

You haven’t played today’s Connections yet. Run `/connections`, then `/share` your grid.

## share.load-failed

Couldn’t load today’s puzzle. Try `/share` again in a moment.

## share.mid-puzzle

Still mid-puzzle: {solved}/4 groups, {mistakes} left. Finish it, then `/share`.

## share.build-failed

Couldn’t build your share. Try `/share` again.

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
