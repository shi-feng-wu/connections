// Builds the daily recap message the bot posts on the Connections reset: an embed
// with yesterday's per-room results and the month's season standings, plus a Play
// button that launches the Activity. Leading underscore keeps Vercel from treating
// this file as a route. Output is plain Discord REST JSON (POST /channels/:id/messages).

// One finisher of yesterday's puzzle in this room (from the day_results RPC).
export type DayRow = {
  name: string;
  score: number;
  mistakes: number;
  solved: boolean;
  duration_ms: number | null;
};

// One season-standings row (a subset of room_board's columns).
export type SeasonRow = {
  name: string;
  total: number;
  wins: number;
  plays: number;
};

// Discord caps: embed description <= 4096, field value <= 1024. Keep well under by
// bounding row counts; a very active room won't overflow a single message.
const MAX_RESULTS = 25;
const MAX_SEASON = 5;
const PLAY_CUSTOM_ID = 'connections_play';

// ms -> m:ss, or an em dash when unknown (e.g. a loss with no recorded duration).
function fmtDuration(ms: number | null): string {
  if (ms == null || ms <= 0) return '—';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export type RecapMessage = {
  embeds: object[];
  components: object[];
};

export function buildRecap(opts: {
  puzzleDate: string;
  puzzleNo?: number;
  results: DayRow[];
  season: SeasonRow[];
}): RecapMessage {
  const heading = opts.puzzleNo ? `#${opts.puzzleNo} · ${opts.puzzleDate}` : opts.puzzleDate;

  const resultLines = opts.results
    .slice(0, MAX_RESULTS)
    .map((r, i) => {
      const mark = r.solved ? '✅' : '❌';
      const mistakes = `${r.mistakes} mistake${r.mistakes === 1 ? '' : 's'}`;
      return `**${i + 1}.** ${r.name} — ${mark} ${r.score} pts · ${mistakes} · ${fmtDuration(r.duration_ms)}`;
    });

  const seasonLines = opts.season
    .slice(0, MAX_SEASON)
    .map((r, i) => `**${i + 1}.** ${r.name} — ${r.total} pts (${r.wins}/${r.plays})`);

  return {
    embeds: [
      {
        title: `Connections — ${heading}`,
        description: resultLines.length ? resultLines.join('\n') : 'No one finished yesterday.',
        fields: [{ name: 'Season standings', value: seasonLines.length ? seasonLines.join('\n') : '—' }],
        color: 0x5865f2,
      },
    ],
    components: [
      {
        type: 1, // action row
        components: [{ type: 2, style: 1, label: 'Play today', custom_id: PLAY_CUSTOM_ID }],
      },
    ],
  };
}

export { PLAY_CUSTOM_ID };
