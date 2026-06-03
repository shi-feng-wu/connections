import type { VercelRequest, VercelResponse } from '@vercel/node';
import { canonicalScope } from '../src/scope.js';
import { admin } from './_admin.js';
import { type CardPlayer, renderRoster } from './_card.js';
import { bearerToken } from './_discord.js';
import {
  activeToken,
  CARD_EDIT_THROTTLE_MS,
  cardEditUrl,
  cardPayload,
  gridFinished,
  sendCard,
  withGrids,
} from './_livecard.js';
import { fetchPuzzle, todayET } from './_nyt.js';
import { isLocalDev, verifyAuth } from './_session.js';

// Re-renders the room's "who's playing today" card with each player's current guess
// grid and edits the card in place. The client fires this (best-effort) after committing
// a guess so the colour squares fill in live, like the Wordle card. The card is the
// launcher's /connections interaction response, edited via the interaction token stored
// on live_cards (no bot/webhook in the guild). Gated by the same cheap auth ticket as
// /api/guess (a verified Discord user, no Discord round-trip). It only EDITS an existing
// card — establishing one stays in /api/interactions — and edits are throttled so a
// flurry of guesses can't spam Discord; a player who just finished bypasses the throttle
// so the final grid always lands. Once the establishing launch's token has expired
// (~15 min) there's nothing to edit until the next launch mints a fresh card.

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
    // The card only lives on a guild channel (same gate as /api/join).
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
      .select('players, interaction_token, token_at, edited_at')
      .eq('scope_id', scope)
      .eq('puzzle_date', date)
      .maybeSingle();
    const players: CardPlayer[] = Array.isArray(card?.players) ? (card.players as CardPlayer[]) : [];
    // No editable card right now (none established, or the launch's token has expired) →
    // nothing to refresh; the next launch will mint a fresh, live card.
    const appId = process.env.VITE_DISCORD_CLIENT_ID ?? '';
    const token = activeToken(card, Date.now());
    if (!token || !appId || !players.length) {
      res.status(200).json({ ok: false, reason: 'no-card' });
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

    const png = await renderRoster(renderPlayers, { puzzleNo: puzzle.id, puzzleDate: date });
    const r = await sendCard(cardEditUrl(appId, token), cardPayload(), png, 'PATCH');
    // Not ok (e.g. 404 token expired/deleted) → leave establishing to /api/interactions.
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
