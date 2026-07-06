import type { SupabaseClient } from '@supabase/supabase-js';
import { Game, MAX_MISTAKES, type Puzzle } from '../src/game.js';

// The single construction of a `scores` row from a finished, server-replayed game — shared by
// the finish-time write in /api/guess (the authoritative path: the score commits in the SAME
// request as the finishing guess, so no second client round-trip exists to lose) and the
// client-posted /api/score fallback (older bundles, and sessions opened before their room was
// stamped). One builder means the two paths can never disagree on how a game is valued.
//
// The identity/room inputs are always server-verified before they reach here: /api/join stamps
// room_auth only after resolving the Discord token and (for g: scopes) confirming guild
// membership; /api/score performs the same two checks inline. Neither path trusts a request
// body for who played, where it counts, or what the guesses were.

export const DURATION_CAP = 24 * 60 * 60 * 1000; // extremes guard; the daily reset is the real bound
export const MAX_GUESSES = 40; // upper bound on a real game's submissions

export type ScoresRow = {
  puzzle_id: number;
  puzzle_date: string;
  scope_id: string;
  channel_id: string | null;
  user_id: string;
  name: string;
  avatar: string | null;
  score: number;
  mistakes: number;
  hints_used: number;
  groups_solved: number;
  solved: boolean;
  duration_ms: number;
};

// `game` must be a finished replay (status won/lost). durationMs is clamped and written onto
// the game BEFORE the score is read, because the speed component depends on it.
export function scoreRow(
  puzzle: Puzzle,
  game: Game,
  who: { userId: string; name: string; avatar: string | null },
  room: { scopeId: string; channelId: string | null },
  durationMs: number,
): ScoresRow {
  game.durationMs = Math.min(DURATION_CAP, Math.max(1000, durationMs));
  return {
    puzzle_id: puzzle.id,
    puzzle_date: puzzle.date,
    scope_id: room.scopeId,
    channel_id: room.channelId,
    user_id: who.userId,
    name: who.name,
    avatar: who.avatar,
    score: game.score,
    mistakes: MAX_MISTAKES - game.mistakesLeft,
    hints_used: game.hintsUsed,
    // groups deduced (0-4); drives the weekly strip's per-day segments,
    // a loss keeps however many the player cracked
    groups_solved: game.groupsSolved,
    solved: game.status === 'won',
    duration_ms: game.durationMs,
  };
}

// First finish wins; ignoreDuplicates means neither path can overwrite the other (or a
// replay of today's puzzle). Returns whether THIS call inserted the row — false means it
// already existed, which is how the fallback path knows the finish-time write got there
// first. Throws on a real write error so callers surface it instead of losing it.
export async function upsertScore(db: SupabaseClient, row: ScoresRow): Promise<boolean> {
  const { data, error } = await db
    .from('scores')
    .upsert(row, { onConflict: 'puzzle_id,user_id', ignoreDuplicates: true })
    .select('user_id');
  if (error) throw new Error(error.message);
  return ((data as unknown[] | null) ?? []).length > 0;
}

// Join-time room stamp (the `room_auth` table): which verified room this player's daily run
// scores into, plus the identity snapshot the scores row needs. Last join wins — you score
// where you most recently opened the Activity, matching the old client-posted semantics.
export async function stampRoomAuth(
  db: SupabaseClient,
  input: {
    userId: string;
    date: string;
    scopeId: string;
    channelId: string | null;
    name: string;
    avatar: string | null;
  },
): Promise<void> {
  await db.from('room_auth').upsert(
    {
      user_id: input.userId,
      puzzle_date: input.date,
      scope_id: input.scopeId,
      channel_id: input.channelId,
      name: input.name,
      avatar: input.avatar,
      verified_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,puzzle_date' },
  );
}
