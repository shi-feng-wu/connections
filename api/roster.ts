import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Game, MAX_MISTAKES, type Puzzle } from '../src/game.js';
import { canonicalScope } from '../src/scope.js';
import { admin } from './_admin.js';
import type { CardPlayer } from './_card.js';
import { bearerToken } from './_discord.js';
import { fetchPuzzle, todayET } from './_nyt.js';
import { isLocalDev, verifyAuth } from './_session.js';

// Persistent "who's played this room today" roster for the live panel. Presence (the
// Supabase channel) only reports who's connected right now, so a player who joined and
// left before you opened the Activity is invisible to it. This returns every player we
// can identify who has played today — replayed server-side from their committed guesses
// (the same record /api/score trusts). The client merges this under live presence: these
// seed the roster, presence overlays the live ones and supplies the green "online" ring.
//
// The player SET is the union of two identity sources, because that's everywhere a
// player's name/avatar is recorded:
//   • live_cards.players — append-only via /api/join (on open, before play) + launches.
//   • scores             — written on every finish by /api/score, scoped the same way.
// Sourcing from live_cards alone dropped anyone whose /api/join never landed (a network
// blip, a membership check, or the finished-gate that permanently blocks re-adds): they
// played, even finished, yet never appeared. Unioning scores recovers every finisher.
//
// Guild rooms only in practice: the client only calls this with a guildId, and
// live_cards.players is written only for g: scopes. Read-gated by the signed auth ticket
// (same as /api/start); the data is the public "who's playing" card content.

type ScoreRow = {
  user_id: string;
  name: string;
  avatar: string | null;
  solved: boolean;
  mistakes: number;
  groups_solved: number;
  duration_ms: number | null;
};
type ProgressRow = { user_id: string; guesses: unknown; started_at: string | null; updated_at: string | null };

// The roster row the client consumes — structurally a PlayerState (src/realtime.ts),
// declared locally so this serverless route never imports client-only code.
type RosterPlayer = {
  userId: string;
  name: string;
  avatar?: string;
  mistakesLeft: number;
  solvedCount: number;
  solvedLevels: number[];
  picking: false;
  done: 'won' | 'lost' | null;
  startedAt: number;
  finishedAt: number | null;
};

// A finished roster row built from a scores row, for a player whose progress row is
// missing/unparseable (or who finished without one). A scores row exists only for a
// finished game, so this is always done.
function synthFromScore(p: CardPlayer, s: ScoreRow, now: number): RosterPlayer {
  const dur = typeof s.duration_ms === 'number' && s.duration_ms > 0 ? s.duration_ms : 0;
  const count = Math.max(0, Math.min(4, s.groups_solved ?? 0));
  return {
    userId: p.id,
    name: p.name,
    avatar: p.avatar ?? undefined,
    mistakesLeft: Math.max(0, MAX_MISTAKES - (s.mistakes ?? 0)),
    solvedCount: count,
    // scores stores only the count, not which levels; approximate with the easiest
    // `count`. Exact for a winner (all four); a partial loss may paint the wrong
    // category colours on the mini-board (cosmetic, rare fallback only).
    solvedLevels: Array.from({ length: count }, (_, i) => i),
    picking: false,
    done: s.solved ? 'won' : 'lost',
    // Frozen timer: roster.tsx elapsed = (finishedAt ?? now) - (startedAt || now) = dur.
    // startedAt must be non-zero (the `|| now` guard), so anchor both at `now`.
    startedAt: now,
    finishedAt: now + dur,
  };
}

// Pure roster assembly, separated from DB I/O so it's unit-testable. The identity set is
// joined ∪ finishers; each player's live state is replayed from their progress row, with
// a scores-derived fallback for finishers whose progress is gone. A player who joined but
// never started (no progress, no score) is dropped — they're in the room but haven't
// played. Without the puzzle we can't replay, so we return only the self-contained
// finishers (frozen) rather than emptying the roster on a transient puzzle-fetch blip.
export function assembleRoster(
  joined: CardPlayer[],
  scoreRows: ScoreRow[],
  progressRows: ProgressRow[],
  puzzle: Puzzle | null,
  now: number,
): RosterPlayer[] {
  const ids = new Map<string, CardPlayer>();
  for (const p of joined) ids.set(p.id, p); // live_cards wins on collision (join-time identity)
  for (const s of scoreRows) if (!ids.has(s.user_id)) ids.set(s.user_id, { id: s.user_id, name: s.name, avatar: s.avatar });

  const scoreById = new Map<string, ScoreRow>();
  for (const s of scoreRows) scoreById.set(s.user_id, s);
  const progById = new Map<string, ProgressRow>();
  for (const r of progressRows) progById.set(r.user_id, r);

  if (!puzzle) {
    return [...ids.values()].flatMap((p) => {
      const s = scoreById.get(p.id);
      return s ? [synthFromScore(p, s, now)] : [];
    });
  }

  return [...ids.values()].flatMap((p) => {
    const row = progById.get(p.id);
    const startedAt = row?.started_at ? Date.parse(row.started_at) : NaN;
    if (!Number.isNaN(startedAt)) {
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
          picking: false as const,
          done,
          startedAt,
          finishedAt: Number.isNaN(finishedAt) ? null : finishedAt,
        },
      ];
    }
    // No usable progress: show them if they finished (scores), else drop (joined, not played).
    const s = scoreById.get(p.id);
    return s ? [synthFromScore(p, s, now)] : [];
  });
}

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
  // Both views are MEMBERSHIP-based (mirrors the leaderboard): the member set is everyone who
  // has ever played in this scope — narrowed to this channel for the Channel view, the whole
  // guild for Server. A member's one daily game then surfaces here wherever they launched it
  // today; members who didn't play today are dropped by assembleRoster.
  const wantChannel = req.body?.scopeMode !== 'server';

  // Members (ever played here) for identity + the set to pull today's state for; plus today's
  // card openers in this channel (first-timers with no prior score, and "opened not finished").
  let memberQ = db.from('scores').select('user_id, name, avatar, created_at').eq('scope_id', scope);
  let cardQ = db.from('live_cards').select('players').eq('scope_id', scope).eq('puzzle_date', date);
  if (wantChannel && channelId) {
    memberQ = memberQ.eq('channel_id', channelId);
    cardQ = cardQ.eq('channel_id', channelId);
  }
  const [{ data: memberData }, { data: cardRows }] = await Promise.all([memberQ, cardQ]);

  // Identity per id: a member's most-recent score name/avatar, then today's card openers
  // override (freshest join-time identity). assembleRoster keeps only those who played today.
  const identity = new Map<string, CardPlayer>();
  for (const r of ((memberData as { user_id: string; name: string; avatar: string | null; created_at: string }[] | null) ?? [])
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))) {
    if (!identity.has(r.user_id)) identity.set(r.user_id, { id: r.user_id, name: r.name, avatar: r.avatar });
  }
  for (const c of (cardRows as { players: unknown }[] | null) ?? []) {
    if (Array.isArray(c.players)) for (const p of c.players as CardPlayer[]) identity.set(p.id, p);
  }
  const joined = [...identity.values()];

  const ids = joined.map((p) => p.id);
  if (!ids.length) {
    res.status(200).json({ players: [] });
    return;
  }

  // Today's finishes + committed progress for the member/opener set — ANY scope, so a member's
  // single daily game follows them into every room they belong to.
  const [puzzle, { data: scoreData }, { data: progData }] = await Promise.all([
    fetchPuzzle(date).catch(() => null),
    db
      .from('scores')
      .select('user_id, name, avatar, solved, mistakes, groups_solved, duration_ms')
      .in('user_id', ids)
      .eq('puzzle_date', date),
    db
      .from('progress')
      .select('user_id, guesses, started_at, updated_at')
      .in('user_id', ids)
      .eq('puzzle_date', date),
  ]);
  const scoreRows = (scoreData as ScoreRow[] | null) ?? [];
  const progressRows = (progData as ProgressRow[] | null) ?? [];

  const players = assembleRoster(joined, scoreRows, progressRows, puzzle, Date.now());
  res.status(200).json({ players });
}
