import type { VercelRequest, VercelResponse } from '@vercel/node';
import { canonicalScope } from '../src/scope.js';
import { admin } from './_admin.js';
import { type CardPlayer, renderRoster } from './_card.js';
import { botCardUrl, cardPayload, claimEditSlot, dmWindowClosing, gridFinished, interactionMessageUrl, playingLine, sendCard, tokenStillEditable, withGrids } from './_livecard.js';
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
    // The relay's trailing flush (scripts/relay.mjs) sets this once room activity settles (~30s after
    // the last guess/join). It bypasses the 30s throttle so the LAST update of a burst always lands —
    // the leading-edge edits from /api/guess only fire once per window and would otherwise drop it.
    // Tense is unchanged (it's a normal present-tense render unless the card is already finalized/all-
    // finished); only the throttle is bypassed.
    const flush = body.flush === true;
    const scope = canonicalScope(guildId, channelId);
    // The finalize cron passes the card's own puzzle_date so a DM card launched just before ET
    // midnight still resolves after midnight (when todayET() has rolled). Guess-driven calls omit it
    // and always mean today's daily.
    const date = typeof body.date === 'string' ? body.date : todayET();

    // Need a scope + channel to locate the per-channel card row.
    if (!scope || !channelId) {
      res.status(200).json({ ok: false, reason: 'no-scope' });
      return;
    }

    const db = admin();
    if (!db) {
      res.status(200).json({ ok: false, reason: 'unavailable' });
      return;
    }

    // Load the card once; HOW we edit it depends on its backing, not its scope. A card created on an
    // interaction token — a DM, a group DM, or a bot-less server (see postDmCard in /api/post-card) —
    // is "token-backed": edited via the launcher's stored token for its ~15-min window, then frozen.
    // A guild card with the bot is "bot-backed": edited via the bot token all day. The bot path never
    // stores an interaction_token, so its presence is the dispatch.
    const { data: card } = await db
      .from('live_cards')
      .select('players, message_id, channel_id, interaction_token, token_at, finalized_at')
      .eq('scope_id', scope)
      .eq('puzzle_date', date)
      .eq('channel_id', channelId)
      .maybeSingle();
    const players: CardPlayer[] = Array.isArray(card?.players) ? (card.players as CardPlayer[]) : [];
    const messageId = (card?.message_id as string | null | undefined) ?? null;
    // No card established yet (no launch posted one) or empty roster → nothing to refresh.
    if (!messageId || !players.length) {
      res.status(200).json({ ok: false, reason: 'no-card' });
      return;
    }

    const editToken = (card?.interaction_token as string | null | undefined) ?? null;
    const tokenAt = (card?.token_at as string | null | undefined) ?? null;
    const tokenBacked = editToken != null;

    // Resolve the edit target + auth for this backing. Bail (frozen) if a token-backed card's ~15-min
    // window has closed, or a bot-backed card has no bot token.
    let url: string;
    let headers: Record<string, string> | undefined;
    if (tokenBacked) {
      const appId = process.env.VITE_DISCORD_CLIENT_ID ?? '';
      if (!appId || !tokenStillEditable(tokenAt, Date.now())) {
        res.status(200).json({ ok: false, reason: 'no-card' });
        return;
      }
      url = interactionMessageUrl(appId, editToken, messageId);
      headers = undefined; // the token is in the URL
    } else {
      const botToken = process.env.DISCORD_BOT_TOKEN ?? '';
      const cardChannel = (card?.channel_id as string | null | undefined) || channelId;
      if (!botToken || !cardChannel) {
        res.status(200).json({ ok: false, reason: 'no-card' });
        return;
      }
      url = botCardUrl(cardChannel, messageId);
      headers = { Authorization: `Bot ${botToken}` };
    }

    // Claim the throttle slot before the heavy render; a just-finished player, the finalize cron, or
    // the relay's trailing flush bypasses the window so the final state always lands.
    if (!(await claimEditSlot(db, scope, date, channelId, finished || finalize || flush))) {
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
    // Tense follows the backing. A token-backed card freezes when its window closes, so it reads past
    // once finalized (sticky), via the finalize cron, or once the token is in its closing window. A
    // bot-backed guild card never freezes, so it flips to past only when everyone who actually played
    // has finished (a join-only lurker with an empty grid doesn't block it).
    let past: boolean;
    if (tokenBacked) {
      const alreadyFinalized = (card?.finalized_at as string | null | undefined) != null;
      past = finalize || alreadyFinalized || dmWindowClosing(tokenAt, Date.now());
    } else {
      const started = renderPlayers.filter((p) => p.grid && p.grid.length > 0);
      past = started.length > 0 && started.every((p) => gridFinished(p.grid));
    }
    const content = playingLine(renderPlayers.map((p) => p.name), past);
    const png = await renderRoster(renderPlayers, { puzzleNo: puzzle.id, puzzleDate: date });
    const r = await sendCard(url, cardPayload({ content }), png, 'PATCH', 'card.png', headers);
    // Not ok (e.g. 404 the card was deleted) → leave establishing to /api/interactions / post-card.
    if (!r.ok) {
      res.status(200).json({ ok: false, reason: 'edit-failed', status: r.status });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
