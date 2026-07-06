import { supabase } from './supabase';

// Room leaderboard over one Supabase `scores` table. One row per player's FIRST
// finish of a puzzle (replays can't improve it; ignoreDuplicates upsert in
// /api/score). `score` from Game.score; losses carry partial credit so count too.
// End screen shows two tabs over the same rows: "this season" (month start) and
// "all-time" (no lower bound), via the room_board / room_self RPCs. A room is the
// guild, or the channel in a DM/group chat.

// Post a finished game for scoring. Client sends only raw inputs: signed session
// (which puzzle + start time), Discord token (identity), raw guild/channel ids.
// /api/score verifies identity, confirms guild membership, derives the canonical
// scope, then replays the player's server-side committed guesses (api/guess) —
// never the browser's word — to time and compute the score. The browser is trusted
// neither with the number nor with which board it lands on.
export async function submitScore(
  input: {
    session: string;
    accessToken: string;
    guildId: string | null;
    channelId: string | null;
  },
  attempt = 0,
): Promise<void> {
  try {
    const r = await fetch('/api/score', {
      method: 'POST',
      // keepalive: if the player closes the Activity the moment they finish, the attempt
      // still leaves the building (the retry loop dies with the document, but the
      // finish-time write in /api/guess is the real safety net — this is the fallback).
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (r.ok) {
      const body = (await r.json()) as { ok?: boolean; reason?: string };
      // "not-finished" = the server replayed the committed record before the finishing
      // guess landed (guesses commit in the background — the optimistic-commit race).
      // The write is at most seconds away, so retry briefly rather than dropping the
      // score: a silent drop here is a lost leaderboard row and a broken streak.
      if (body.ok !== false || body.reason !== 'not-finished' || attempt >= 3) return;
    } else if (attempt >= 3) {
      return; // non-2xx after retries: give up (server rejected or is down)
    }
  } catch {
    /* network blip → retry below */
    if (attempt >= 3) return;
  }
  await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
  return submitScore(input, attempt + 1);
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
// for the season tab, `null` for all-time. `channelId` narrows to one channel (the
// "this channel" view); null/omitted = the whole server (all history).
export async function roomBoard(
  scopeId: string,
  since: string | null,
  limit = 50,
  channelId: string | null = null,
): Promise<BoardRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('room_board', {
    p_scope: scopeId,
    p_since: since,
    p_limit: limit,
    ...(channelId ? { p_channel: channelId } : {}),
  });
  if (error) return [];
  return (data ?? []) as BoardRow[];
}

// One player's standing in a room over a window (rank, total players, stats).
// `channelId` narrows to one channel; null/omitted = the whole server.
export async function roomSelf(
  scopeId: string,
  since: string | null,
  userId: string,
  channelId: string | null = null,
): Promise<SelfStanding | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('room_self', {
    p_scope: scopeId,
    p_since: since,
    p_user: userId,
    ...(channelId ? { p_channel: channelId } : {}),
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
