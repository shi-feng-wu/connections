import type { VercelRequest, VercelResponse } from '@vercel/node';
import { canonicalScope } from '../src/scope.js';
import { admin } from './_admin.js';
import { renderRoster, type CardPlayer } from './_card.js';
import { bearerToken } from './_discord.js';
import { CARD_EDIT_THROTTLE_MS, cardPayload, gridFinished, sendCard, withGrids } from './_livecard.js';
import { fetchPuzzle, todayET } from './_nyt.js';
import { isLocalDev, verifyAuth } from './_session.js';

// Re-renders the room's "who's playing today" card with each player's current guess
// grid and edits the existing webhook message in place. The client fires this (best-
// effort) after committing a guess so the colour squares fill in live, like the Wordle
// card. Gated by the same cheap auth ticket as /api/guess (a verified Discord user, no
// Discord round-trip). It only EDITS an existing card — posting and bumping stay in
// /api/join — and edits are throttled so a flurry of guesses can't spam Discord; a
// player who just finished bypasses the throttle so the final grid always lands.

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const auth = verifyAuth(bearerToken(req.headers.authorization));
  if (!isLocalDev() && !auth) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const uid = auth?.uid ?? null;

  try {
    const body = req.body ?? {};
    const guildId = typeof body.guildId === 'string' ? body.guildId : null;
    const channelId = typeof body.channelId === 'string' ? body.channelId : null;
    const scope = canonicalScope(guildId, channelId);
    // The card only lives on a guild channel's webhook (same gate as /api/join).
    if (!scope || !scope.startsWith('g:')) {
      res.status(200).json({ ok: false, reason: 'no-guild' });
      return;
    }

    const db = admin();
    if (!db) {
      res.status(200).json({ ok: false, reason: 'unavailable' });
      return;
    }

    const date = todayET();
    const { data: card } = await db
      .from('live_cards')
      .select('players, message_id, edited_at')
      .eq('scope_id', scope)
      .eq('puzzle_date', date)
      .maybeSingle();
    const messageId = (card?.message_id as string | null | undefined) ?? null;
    const players: CardPlayer[] = Array.isArray(card?.players) ? (card.players as CardPlayer[]) : [];
    // No card to edit yet (a join hasn't posted one) → nothing to refresh.
    if (!messageId || !players.length) {
      res.status(200).json({ ok: false, reason: 'no-card' });
      return;
    }

    const { data: chan } = await db
      .from('recap_channels')
      .select('webhook_url')
      .eq('scope_id', scope)
      .maybeSingle();
    const webhookUrl = chan?.webhook_url as string | null | undefined;
    if (!webhookUrl) {
      res.status(200).json({ ok: false, reason: 'no-webhook' });
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

    // Throttle live edits, but let a player whose game just finished through so the
    // final grid always shows (their own grid, so it can't be spoofed to bypass).
    const finished = gridFinished(renderPlayers.find((p) => p.id === uid)?.grid);
    const lastEdit = card?.edited_at ? Date.parse(card.edited_at as string) : null;
    if (!finished && lastEdit && Date.now() - lastEdit < CARD_EDIT_THROTTLE_MS) {
      res.status(200).json({ ok: true, throttled: true });
      return;
    }

    const png = await renderRoster(renderPlayers, { puzzleNo: puzzle.id });
    const payload = cardPayload();
    const r = await sendCard(`${webhookUrl}/messages/${messageId}?with_components=true`, payload, png, 'PATCH');
    // 404 → the card was deleted; leave reposting to /api/join, don't bump from here.
    if (!r.ok) {
      res.status(200).json({ ok: false, reason: 'edit-failed', status: r.status });
      return;
    }

    await db
      .from('live_cards')
      .update({ edited_at: new Date().toISOString() })
      .eq('scope_id', scope)
      .eq('puzzle_date', date);
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
