import type { VercelRequest, VercelResponse } from '@vercel/node';
import { canonicalScope } from '../src/scope.js';
import { admin } from './_admin.js';
import { type CardPlayer, renderRoster } from './_card.js';
import { botCardUrl, cardPayload, claimEditSlot, gridFinished, interactionMessageUrl, playingLine, sendCard, tokenStillEditable, withGrids } from './_livecard.js';
import { fetchPuzzle, todayET } from './_nyt.js';

// Re-renders the room's "who's playing today" card with each player's current guess grid and edits
// the card in place, so the colour squares fill in live like the Wordle card. Fired server-to-server
// by /api/guess on every counted guess — the SAME authoritative event that drives the live roster —
// NOT by the client, so the card tracks progress, not just the solve. Authenticated with
// INTERNAL_SECRET (mirrors /api/post-card): the secret proves the call came from our own function,
// which is why the `finished` flag in the body can be trusted to bypass the throttle. Edits are
// rate-limited to one per CARD_UPDATE_THROTTLE_MS via an atomic claim (claimEditSlot) so a flurry
// of guesses can't spam Discord or double-render; a finished grid bypasses the window so the final
// board always lands. It only EDITS an existing card — establishing one stays in /api/interactions
// (guild) / /api/post-card (DM).

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  // Internal-only: a server-to-server call from /api/guess, authenticated by the shared secret. The
  // `!secret ||` guard means a deploy missing INTERNAL_SECRET rejects everything rather than
  // accepting a bare "Bearer ". The user client never calls this directly.
  const secret = process.env.INTERNAL_SECRET ?? '';
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  try {
    const body = req.body ?? {};
    const guildId = typeof body.guildId === 'string' ? body.guildId : null;
    const channelId = typeof body.channelId === 'string' ? body.channelId : null;
    const finished = body.finished === true;
    // The finalize cron (api/finalize-cards) sets this just before a DM card's edit window closes:
    // it forces the "who's playing" caption to past tense and bypasses the throttle so the final
    // edit always lands. Only reachable internally (INTERNAL_SECRET), so it can't be spoofed.
    const finalize = body.finalize === true;
    const scope = canonicalScope(guildId, channelId);
    // The finalize cron passes the card's own puzzle_date so a DM card launched just before ET
    // midnight still resolves after midnight (when todayET() has rolled). Guess-driven calls omit it
    // and always mean today's daily.
    const date = typeof body.date === 'string' ? body.date : todayET();

    // DM/group-DM card (no bot): keep its grids live by editing via the launcher's stored
    // interaction token, but only while it's inside Discord's ~15-min window — past that the card is
    // frozen. We only re-render the EXISTING roster (membership is built by Play-clicks in
    // postDmCard), so there's nothing to spoof.
    if (scope && scope.startsWith('c:') && channelId) {
      const db = admin();
      if (!db) {
        res.status(200).json({ ok: false, reason: 'unavailable' });
        return;
      }
      const { data: card } = await db
        .from('live_cards')
        .select('players, message_id, interaction_token, token_at, finalized_at')
        .eq('scope_id', scope)
        .eq('puzzle_date', date)
        .eq('channel_id', channelId)
        .maybeSingle();
      const players: CardPlayer[] = Array.isArray(card?.players) ? (card.players as CardPlayer[]) : [];
      const messageId = (card?.message_id as string | null | undefined) ?? null;
      const editToken = (card?.interaction_token as string | null | undefined) ?? null;
      const appId = process.env.VITE_DISCORD_CLIENT_ID ?? '';
      // No card, no token, the window has closed, or no roster → nothing to refresh.
      if (
        !messageId ||
        !editToken ||
        !appId ||
        !players.length ||
        !tokenStillEditable(card?.token_at as string | null | undefined, Date.now())
      ) {
        res.status(200).json({ ok: false, reason: 'no-card' });
        return;
      }
      // Claim the throttle slot before the heavy render; a just-finished player or the finalize
      // cron bypasses the window.
      if (!(await claimEditSlot(db, scope, date, channelId, finished || finalize))) {
        res.status(200).json({ ok: true, throttled: true });
        return;
      }
      let puzzle;
      try {
        puzzle = await fetchPuzzle(date);
      } catch {
        res.status(200).json({ ok: false, reason: 'no-puzzle' });
        return;
      }
      const renderPlayers = await withGrids(db, puzzle, date, players);
      // DM cards stay present tense until the finalize cron flips them just before the token window
      // closes (per the chosen "timer before window" behaviour — a DM doesn't flip on finish). Once
      // finalized, the past tense is STICKY: a later guess inside the remaining token window must not
      // re-render it back to present (the cron won't fire again to re-fix it).
      const alreadyFinalized = (card?.finalized_at as string | null | undefined) != null;
      const content = playingLine(renderPlayers.map((p) => p.name), finalize || alreadyFinalized);
      const png = await renderRoster(renderPlayers, { puzzleNo: puzzle.id, puzzleDate: date });
      const r = await sendCard(
        interactionMessageUrl(appId, editToken, messageId),
        cardPayload({ content }),
        png,
        'PATCH',
        'card.png',
      );
      if (!r.ok) {
        res.status(200).json({ ok: false, reason: 'edit-failed', status: r.status });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    // The card only lives on a guild channel (same gate as /api/join); per-channel, so a channel id
    // is required to locate the right card.
    if (!scope || !scope.startsWith('g:') || !channelId) {
      res.status(200).json({ ok: false, reason: 'no-guild' });
      return;
    }

    const db = admin();
    if (!db) {
      res.status(200).json({ ok: false, reason: 'unavailable' });
      return;
    }

    const { data: card } = await db
      .from('live_cards')
      .select('players, message_id, channel_id')
      .eq('scope_id', scope)
      .eq('puzzle_date', date)
      .eq('channel_id', channelId)
      .maybeSingle();
    const players: CardPlayer[] = Array.isArray(card?.players) ? (card.players as CardPlayer[]) : [];
    const botToken = process.env.DISCORD_BOT_TOKEN ?? '';
    const messageId = (card?.message_id as string | null | undefined) ?? null;
    const cardChannel = (card?.channel_id as string | null | undefined) || channelId;
    // No card to edit yet (no launch established one) → nothing to refresh.
    if (!messageId || !botToken || !cardChannel || !players.length) {
      res.status(200).json({ ok: false, reason: 'no-card' });
      return;
    }

    // Claim the throttle slot before the heavy render; a just-finished player bypasses the window so
    // the final grid always lands.
    if (!(await claimEditSlot(db, scope, date, channelId, finished))) {
      res.status(200).json({ ok: true, throttled: true });
      return;
    }

    let puzzle;
    try {
      puzzle = await fetchPuzzle(date);
    } catch {
      res.status(200).json({ ok: false, reason: 'no-puzzle' });
      return;
    }

    const renderPlayers = await withGrids(db, puzzle, date, players);
    // Guild cards have no edit-window to expire, so their caption flips to past tense once everyone
    // who actually played has finished today's puzzle (replayed from the grids). Players who only
    // clicked Play but never guessed (empty grid) don't count — otherwise one lurker would keep the
    // card in present tense all day.
    const started = renderPlayers.filter((p) => p.grid && p.grid.length > 0);
    const allFinished = started.length > 0 && started.every((p) => gridFinished(p.grid));
    const content = playingLine(renderPlayers.map((p) => p.name), allFinished);
    const png = await renderRoster(renderPlayers, { puzzleNo: puzzle.id, puzzleDate: date });
    const r = await sendCard(botCardUrl(cardChannel, messageId), cardPayload({ content }), png, 'PATCH', 'card.png', {
      Authorization: `Bot ${botToken}`,
    });
    // Not ok (e.g. 404 the card was deleted) → leave establishing to /api/interactions.
    if (!r.ok) {
      res.status(200).json({ ok: false, reason: 'edit-failed', status: r.status });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
