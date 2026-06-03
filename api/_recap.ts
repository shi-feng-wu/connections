// Shapes the daily recap the bot posts on the Connections reset and turns the two
// RPC result sets (yesterday's finishers + the month's season standings) into the
// render model for the recap PNG. The drawing itself lives in src/card-draw.ts
// (shared with the browser preview); api/_card.ts wraps it into a Buffer and
// api/cron-recap.ts posts it — exactly like the "who's playing" card. Leading
// underscore keeps Vercel from treating this file as a route.
import type { RecapData } from '../src/card-draw.js';

// One finisher of yesterday's puzzle in this room (from the day_results RPC). The RPC
// also returns user_id + avatar (used for the row's roster avatar).
export type DayRow = {
  user_id: string;
  name: string;
  avatar: string | null;
  score: number;
  mistakes: number;
  solved: boolean;
  duration_ms: number | null;
};

// One season-standings row (from the room_board RPC; a subset of its columns).
export type SeasonRow = {
  user_id: string;
  name: string;
  avatar: string | null;
  total: number;
  wins: number;
  plays: number;
};

const PLAY_CUSTOM_ID = 'connections_play';

const MON = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
// "2026-05-30" -> "May" (the standings window label).
function monthOf(date: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(date);
  return m ? MON[+m[2] - 1] : undefined;
}

// Map the two RPC result sets (plus the room's header stats) into the recap render
// model consumed by drawRecap. duration_ms -> seconds; user_id -> the avatar hash id.
export function toRecapData(opts: {
  puzzleDate: string;
  puzzleNo?: number;
  results: DayRow[];
  season: SeasonRow[];
  streak?: number | null;
  winRate?: number | null;
}): RecapData {
  return {
    puzzleNo: opts.puzzleNo,
    puzzleDate: opts.puzzleDate,
    season: monthOf(opts.puzzleDate),
    streak: opts.streak ?? null,
    winRate: opts.winRate ?? null,
    results: opts.results.map((r) => ({
      id: r.user_id,
      name: r.name,
      avatar: r.avatar,
      solved: r.solved,
      score: r.score,
      mistakes: r.mistakes,
      sec: r.duration_ms != null ? Math.round(r.duration_ms / 1000) : null,
    })),
    standings: opts.season.map((r) => ({
      id: r.user_id,
      name: r.name,
      avatar: r.avatar,
      total: r.total,
      wins: r.wins,
      plays: r.plays,
    })),
  };
}

// Fire-emoji intensity for the streak headline — more days, more flames (capped at 3).
function streakFlames(streak: number): string {
  const n = streak >= 100 ? 3 : streak >= 30 ? 2 : 1;
  return '🔥'.repeat(n);
}

// The label for one result group, Wordle-style: solvers are grouped by their mistake
// count (0 reads as a clean "Perfect"); non-solvers land under "X" (see recapText).
function resultLabel(mistakes: number): string {
  if (mistakes <= 0) return 'Perfect';
  return `${mistakes} mistake${mistakes === 1 ? '' : 's'}`;
}

// A Discord user mention; the recap pings each finisher, like the Wordle bot's summary.
function mention(r: DayRow): string {
  return `<@${r.user_id}>`;
}

// Wordle-style text body posted above the recap PNG: a group-streak headline followed by
// yesterday's finishers grouped by result — solvers best-first (fewest mistakes, crown on
// the top group), non-solvers under "X" — each player @mentioned. Mirrors the Wordle bot's
// daily recap. Assembled under Discord's 2000-char message limit; overflow groups are
// dropped rather than truncated mid-mention.
export function recapText(opts: { streak: number | null; results: DayRow[] }): string {
  const streak = opts.streak ?? 0;
  const head =
    streak >= 1
      ? `Your group is on a ${streak} day streak! ${streakFlames(streak)} Here are yesterday's results:`
      : "Here are yesterday's results:";

  // Group solvers by mistakes (ascending key = best first); collect non-solvers for "X".
  const byMistakes = new Map<number, DayRow[]>();
  const losers: DayRow[] = [];
  for (const r of opts.results) {
    if (!r.solved) {
      losers.push(r);
      continue;
    }
    const list = byMistakes.get(r.mistakes) ?? [];
    list.push(r);
    byMistakes.set(r.mistakes, list);
  }

  const groups: string[] = [...byMistakes.keys()]
    .sort((a, b) => a - b)
    .map((m, i) => `${i === 0 ? '👑 ' : ''}${resultLabel(m)}: ${byMistakes.get(m)!.map(mention).join(' ')}`);
  if (losers.length) groups.push(`X: ${losers.map(mention).join(' ')}`);

  // Stay under Discord's 2000-char limit by dropping trailing groups that don't fit.
  let text = head;
  for (const line of groups) {
    if (text.length + 1 + line.length > 1990) break;
    text += `\n${line}`;
  }
  return text;
}

// The Discord message: the rendered recap PNG plus the Play button, with an optional
// Wordle-style text body (recapText). The image carries the visual recap (title, results,
// standings) as a bare inline attachment — no embed, so Discord draws no frame/border or
// coloured side bar; the PNG sits directly in the message. Same shape as the live card's
// cardPayload, with a recap.png attachment.
export function recapPayload(content?: string): object {
  return {
    ...(content ? { content } : {}),
    components: [
      { type: 1, components: [{ type: 2, style: 1, label: 'Play now!', custom_id: PLAY_CUSTOM_ID }] },
    ],
    attachments: [{ id: 0, filename: 'recap.png' }],
  };
}

export { PLAY_CUSTOM_ID };
