import { waitUntil } from '@vercel/functions';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Puzzle } from '../src/game.js';
import { canonicalScope } from '../src/scope.js';
import { admin } from './_admin.js';
import { type CardPlayer, mergePlayer, renderRoster } from './_card.js';
import { botInGuild, fetchDiscordUser, fetchUserGuildIds } from './_discord.js';
import { botCardUrl, CARD_JOIN_THROTTLE_MS, cardPayload, playerFinished, sendCard, withGrids } from './_livecard.js';
import { fetchPuzzle, todayET } from './_nyt.js';
import { broadcastRoom } from './_realtime.js';

// Registers a player on the room's "who's playing today" card when they open the
// Activity, then refreshes the card. The card is a bot message in the channel (posted
// as a reply to a /connections launch by /api/interactions), edited in place via the
// bot token. Identity is resolved from the Discord token (not the body), and a guild
// board is only touched after confirming membership (same gate as /api/score). The
// roster is append-only — opening adds you, leaving never removes you. /api/join only
// EDITS an existing card; the first card is established by a launch (which knows the
// message to reply to). If no card exists yet (e.g. the launcher's wasn't a guild
// install), the roster is still recorded. Each tile shows the player's live guess grid,
// kept current by /api/refresh-card. Best-effort: any failure just means no card.

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const body = req.body ?? {};

    // Authoritative identity (never the body).
    const user = await fetchDiscordUser(body.accessToken);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }

    // The card lives on a guild channel, so only g: scopes get one.
    const guildId = typeof body.guildId === 'string' ? body.guildId : null;
    const channelId = typeof body.channelId === 'string' ? body.channelId : null;
    const scope = canonicalScope(guildId, channelId);
    // Per-channel card: no channel, no card (the card lives in the channel you're in).
    if (!scope || !scope.startsWith('g:') || !guildId || !channelId) {
      res.status(200).json({ ok: false, reason: 'no-guild' });
      return;
    }

    const db = admin();
    if (!db) {
      res.status(503).json({ error: 'unavailable' });
      return;
    }

    // Whether this server has the bot (guild install), kicked off now so it overlaps the
    // puzzle/DB work below. The app keys its install prompts (loading tip, end-screen
    // recap pitch) off this: true/false is definitive, null means "couldn't tell" and the
    // client shows nothing rather than pitching a server that may already have the bot.
    // Every guild response carries it — including the early "finished" return, since the
    // end screen (where the pitch lives) is exactly where a finished player lands.
    const botInstalled = botInGuild(guildId, process.env.DISCORD_BOT_TOKEN ?? '');

    const date = todayET();

    // A player who already finished today (won or lost) isn't playing anymore, so opening
    // the Activity shouldn't (re)add them to the room card. Replayed from their committed
    // guesses. The puzzle is also reused for the live grid render below; if it can't be
    // fetched we can't tell, so we fall through and treat them as still playing.
    let puzzle: Puzzle | null = null;
    try {
      puzzle = await fetchPuzzle(date);
    } catch {
      /* title falls back to no number; grids render blank */
    }
    if (puzzle && (await playerFinished(db, puzzle, user.id, date))) {
      res.status(200).json({ ok: false, reason: 'finished', botInstalled: await botInstalled });
      return;
    }

    const { data: card } = await db
      .from('live_cards')
      .select('players, message_id, channel_id, edited_at')
      .eq('scope_id', scope)
      .eq('puzzle_date', date)
      .eq('channel_id', channelId)
      .maybeSingle();
    const existing: CardPlayer[] = Array.isArray(card?.players) ? (card.players as CardPlayer[]) : [];

    // Authorize the guild before writing its card (guild ids are public).
    const guilds = await fetchUserGuildIds(body.accessToken);
    if (!guilds || !guilds.includes(guildId)) {
      res.status(403).json({ ok: false, reason: 'not-a-member' });
      return;
    }

    const { players } = mergePlayer(existing, {
      id: user.id,
      name: user.name,
      avatar: user.avatar ?? null,
    });

    // Edit the room's card in place if one exists (a launch established it). /api/join
    // never creates the card itself — it has no launch message to reply to — so without
    // an existing card it just records the roster for the next launch/refresh to show.
    // Throttled like /api/refresh-card so a burst of opens can't spam the webhook; the
    // dropped join's player still lands in the upsert and shows on the next edit.
    const botToken = process.env.DISCORD_BOT_TOKEN ?? '';
    const messageId = (card?.message_id as string | null | undefined) ?? null;
    const cardChannel = (card?.channel_id as string | null | undefined) || channelId;
    const lastEdit = card?.edited_at ? Date.parse(card.edited_at as string) : null;
    const throttled = lastEdit != null && Date.now() - lastEdit < CARD_JOIN_THROTTLE_MS;
    let edited = false;
    if (messageId && botToken && cardChannel && !throttled) {
      const renderPlayers = puzzle ? await withGrids(db, puzzle, date, players) : players;
      const png = await renderRoster(renderPlayers, { puzzleNo: puzzle?.id, puzzleDate: date });
      const r = await sendCard(botCardUrl(cardChannel, messageId), cardPayload(), png, 'PATCH', 'card.png', {
        Authorization: `Bot ${botToken}`,
      });
      edited = r.ok;
    }

    const now = new Date().toISOString();
    // message_id is omitted so the launch-established value survives (an upsert only
    // overwrites the columns it lists). channel_id is required now that it's part of the
    // per-channel PK; it's the channel this player is in, which is the card's channel.
    await db.from('live_cards').upsert(
      {
        scope_id: scope,
        puzzle_date: date,
        channel_id: channelId,
        players,
        ...(edited ? { edited_at: now } : {}),
        updated_at: now,
      },
      { onConflict: 'scope_id,puzzle_date,channel_id' },
    );

    // Tell everyone watching this room's roster that a new player is here, instantly — their
    // tile appears without waiting for a backstop poll. Identity only; the player's progress
    // arrives on their first guess broadcast (or the next backstop). Off the response path.
    waitUntil(
      broadcastRoom(scope, 'join', {
        userId: user.id,
        channelId,
        name: user.name,
        avatar: user.avatar ?? undefined,
      }),
    );

    res.status(200).json({ ok: true, edited, players: players.length, botInstalled: await botInstalled });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
