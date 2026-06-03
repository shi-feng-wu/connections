import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { Puzzle } from '../src/game.js';
import { canonicalScope } from '../src/scope.js';
import { admin } from './_admin.js';
import { type CardPlayer, mergePlayer, renderRoster } from './_card.js';
import { fetchDiscordUser, fetchUserGuildIds } from './_discord.js';
import { activeToken, cardEditUrl, cardPayload, sendCard, withGrids } from './_livecard.js';
import { fetchPuzzle, todayET } from './_nyt.js';

// Registers a player on the room's "who's playing today" card when they open the
// Activity, then refreshes the card. The card is the launcher's /connections interaction
// response (established by /api/interactions), edited in place via the interaction token
// stored on live_cards — so there's no bot or webhook in the guild. Identity is resolved
// from the Discord token (not the body), and a guild board is only touched after
// confirming membership (same gate as /api/score). The roster is append-only — opening
// adds you, leaving never removes you. The card can only be edited while the establishing
// launch's token is still alive (~15 min, which covers a game); once it has expired the
// new roster is still recorded so the next launch shows it. Each tile shows the player's
// live guess grid, kept current by /api/refresh-card as they play. Best-effort: any
// failure just means no card.

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

    // The card lives on a guild channel's interaction response, so only g: scopes get one.
    const guildId = typeof body.guildId === 'string' ? body.guildId : null;
    const channelId = typeof body.channelId === 'string' ? body.channelId : null;
    const scope = canonicalScope(guildId, channelId);
    if (!scope || !scope.startsWith('g:') || !guildId) {
      res.status(200).json({ ok: false, reason: 'no-guild' });
      return;
    }

    const db = admin();
    if (!db) {
      res.status(503).json({ error: 'unavailable' });
      return;
    }

    const date = todayET();
    const { data: card } = await db
      .from('live_cards')
      .select('players, interaction_token, token_at')
      .eq('scope_id', scope)
      .eq('puzzle_date', date)
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

    // Edit the room's active card now if its establishing launch's token is still alive;
    // otherwise just record the roster so the next launch (which mints a fresh token)
    // shows this player. The launch that opened the Activity normally just established
    // the card, so the token is fresh here.
    const appId = process.env.VITE_DISCORD_CLIENT_ID ?? '';
    const token = activeToken(card, Date.now());
    let edited = false;
    if (token && appId) {
      let puzzle: Puzzle | null = null;
      try {
        puzzle = await fetchPuzzle(date);
      } catch {
        /* title falls back to no number; grids render blank */
      }
      const renderPlayers = puzzle ? await withGrids(db, puzzle, date, players) : players;
      const png = await renderRoster(renderPlayers, { puzzleNo: puzzle?.id, puzzleDate: date });
      const r = await sendCard(cardEditUrl(appId, token), cardPayload(), png, 'PATCH');
      edited = r.ok;
    }

    const now = new Date().toISOString();
    // interaction_token/token_at are omitted so the establishing launch's values survive
    // (an upsert only overwrites the columns it lists).
    await db.from('live_cards').upsert(
      {
        scope_id: scope,
        puzzle_date: date,
        players,
        ...(edited ? { edited_at: now } : {}),
        updated_at: now,
      },
      { onConflict: 'scope_id,puzzle_date' },
    );
    res.status(200).json({ ok: true, edited, players: players.length });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
