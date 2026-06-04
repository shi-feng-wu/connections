import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Game } from '../src/game.js';
import { canonicalScope } from '../src/scope.js';
import { admin } from './_admin.js';
import type { CardPlayer } from './_card.js';
import { bearerToken } from './_discord.js';
import { fetchPuzzle, todayET } from './_nyt.js';
import { isLocalDev, verifyAuth } from './_session.js';

// Persistent "who's played this room today" roster for the live panel. Presence (the
// Supabase channel) only reports who's connected right now, so a player who joined and
// left before you opened the Activity is invisible to it. This returns every player
// recorded on the room's live_cards entry — append-only via /api/join + launches — who
// has started the puzzle, with state replayed server-side from their committed guesses
// (the same record /api/score trusts). The client merges this under live presence: these
// seed the roster, presence overlays the live ones and supplies the green "online" ring.
//
// Guild rooms only: live_cards.players is written only for g: scopes (/api/join short-
// circuits other contexts), so a DM/group returns an empty list and the client falls back
// to presence alone. Read-gated by the signed auth ticket (same as /api/start); the data
// is the public "who's playing" card content, so no per-guild membership check is needed.

type ProgressRow = { user_id: string; guesses: unknown; started_at: string | null; updated_at: string | null };

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

  const guildId = typeof req.body?.guildId === 'string' ? req.body.guildId : null;
  const channelId = typeof req.body?.channelId === 'string' ? req.body.channelId : null;
  const scope = canonicalScope(guildId, channelId);
  const db = admin();
  // No scope, no store, or a context with no persistent roster → presence-only on the client.
  if (!scope || !db) {
    res.status(200).json({ players: [] });
    return;
  }

  const date = todayET();
  const { data: card } = await db
    .from('live_cards')
    .select('players')
    .eq('scope_id', scope)
    .eq('puzzle_date', date)
    .maybeSingle();
  const joined: CardPlayer[] = Array.isArray(card?.players) ? (card.players as CardPlayer[]) : [];
  if (!joined.length) {
    res.status(200).json({ players: [] });
    return;
  }

  const puzzle = await fetchPuzzle(date).catch(() => null);
  if (!puzzle) {
    res.status(200).json({ players: [] });
    return;
  }

  // One query for the whole roster's committed progress; replay each to derive state.
  const { data } = await db
    .from('progress')
    .select('user_id, guesses, started_at, updated_at')
    .in('user_id', joined.map((p) => p.id))
    .eq('puzzle_date', date);
  const byId = new Map<string, ProgressRow>();
  for (const row of (data as ProgressRow[] | null) ?? []) byId.set(row.user_id, row);

  // Only players who actually started their timer (have a progress row) are shown.
  const players = joined.flatMap((p) => {
    const row = byId.get(p.id);
    const startedAt = row?.started_at ? Date.parse(row.started_at) : NaN;
    if (Number.isNaN(startedAt)) return [];
    const guesses = row && Array.isArray(row.guesses) ? (row.guesses as string[][]) : [];
    const game = Game.fromGuesses(puzzle, guesses, startedAt);
    const done = game.status === 'playing' ? null : game.status;
    const finishedAt = done && row?.updated_at ? Date.parse(row.updated_at) : NaN;
    const solvedLevels = game.deducedLevels;
    return [
      {
        userId: p.id,
        name: p.name,
        avatar: p.avatar ?? undefined,
        mistakesLeft: game.mistakesLeft,
        solvedCount: solvedLevels.length,
        solvedLevels,
        picking: false,
        done,
        startedAt,
        finishedAt: Number.isNaN(finishedAt) ? null : finishedAt,
      },
    ];
  });

  res.status(200).json({ players });
}
