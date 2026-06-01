import { supabase } from './supabase';

// Room leaderboard over one Supabase `scores` table. One row per player's FIRST
// finish of a puzzle (replays can't improve it; ignoreDuplicates upsert in
// /api/score). `score` from Game.score; losses carry partial credit so count too.
// End screen shows two tabs over the same rows: "this season" (month start) and
// "all-time" (no lower bound), via the room_board / room_self RPCs. A room is the
// guild, or the channel in a DM/group chat.

// Submit a finished game. Client sends only raw inputs: signed session (which
// puzzle + start time), Discord token (identity), raw guild/channel ids, guesses.
// /api/score verifies identity, confirms guild membership, derives the canonical
// scope, replays, times, and computes the score. The browser is never trusted
// with the number or with which board it lands on.
export async function submitScore(input: {
  session: string;
  accessToken: string;
  guildId: string | null;
  channelId: string | null;
  guesses: string[][];
}): Promise<void> {
  try {
    await fetch('/api/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    /* best-effort; a failed submit means no leaderboard row */
  }
}

// One leaderboard row: cumulative score over the window plus stats.
export type BoardRow = {
  user_id: string;
  name: string;
  avatar: string | null;
  total: number; // cumulative score this window
  plays: number;
  wins: number;
  win_pct: number; // 0-100
  avg_mistakes: number;
  streak: number; // consecutive solved days; loss/gap ends it (all-time)
};

// One player's standing for a window; the end screen's pinned "your" row.
export type SelfStanding = {
  rank: number | null; // null when the player has no scored row in this window
  total_players: number;
  total: number;
  plays: number;
  wins: number;
  win_pct: number;
  avg_mistakes: number;
  streak: number;
};

// Leaderboard rows for a room over a window, richest-first. `currentSeasonStart()`
// for the season tab, `null` for all-time.
export async function roomBoard(
  scopeId: string,
  since: string | null,
  limit = 50,
): Promise<BoardRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('room_board', {
    p_scope: scopeId,
    p_since: since,
    p_limit: limit,
  });
  if (error) return [];
  return (data ?? []) as BoardRow[];
}

// One player's standing in a room over a window (rank, total players, stats).
export async function roomSelf(
  scopeId: string,
  since: string | null,
  userId: string,
): Promise<SelfStanding | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('room_self', {
    p_scope: scopeId,
    p_since: since,
    p_user: userId,
  });
  if (error || !data) return null;
  return data as SelfStanding;
}

// First day of the current month as YYYY-MM-DD; the "this season" window start.
export function currentSeasonStart(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}
