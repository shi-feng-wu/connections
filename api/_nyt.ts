// Shared NYT puzzle helper. Leading underscore keeps Vercel from treating this
// file as a route. Fetches and normalizes the official daily Connections puzzle:
// categories are difficulty 0-3, and each card's board position rebuilds the exact
// starting layout.

export type Group = { level: number; category: string; members: string[] };
export type Puzzle = {
  id: number;
  date: string;
  editor: string;
  groups: Group[];
  layout: string[];
};

type RawCard = { content: string; position: number };
type RawCategory = { title: string; cards: RawCard[] };
type RawPuzzle = {
  status: string;
  id: number;
  print_date: string;
  editor: string;
  categories: RawCategory[];
};

const BASE = 'https://www.nytimes.com/svc/connections/v2';
export const FIRST_DATE = '2023-06-12'; // Connections puzzle #1
const DAY = 86_400_000;
const cache = new Map<string, Puzzle>();

export async function fetchPuzzle(dateStr: string): Promise<Puzzle> {
  const cached = cache.get(dateStr);
  if (cached) return cached;

  const res = await fetch(`${BASE}/${dateStr}.json`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Connections Activity)', Accept: 'application/json' },
  });
  if (res.status === 404) throw new Error('NOT_FOUND');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const raw = (await res.json()) as RawPuzzle;
  if (raw.status !== 'OK' || !Array.isArray(raw.categories) || raw.categories.length !== 4) {
    throw new Error('NOT_FOUND');
  }

  const groups: Group[] = raw.categories.map((cat, level) => ({
    level,
    category: cat.title,
    members: cat.cards.map((c) => c.content),
  }));
  const layout: string[] = new Array(16);
  raw.categories.forEach((cat) =>
    cat.cards.forEach((card) => {
      layout[card.position] = card.content;
    }),
  );

  const puzzle: Puzzle = { id: raw.id, date: raw.print_date, editor: raw.editor, groups, layout };
  cache.set(dateStr, puzzle);
  return puzzle;
}

const atNoonUTC = (d: string): number => Date.parse(`${d}T12:00:00Z`);
const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function todayET(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// The ET calendar day before today. Anchoring at noon UTC keeps a 1h DST shift
// from ever crossing a day boundary, so subtracting one day is exact year-round
// (same trick randomDate relies on). The cron uses this for "yesterday's puzzle".
export function yesterdayET(): string {
  return ymd(atNoonUTC(todayET()) - DAY);
}

export function randomDate(): string {
  const days = Math.floor((atNoonUTC(todayET()) - atNoonUTC(FIRST_DATE)) / DAY);
  return ymd(atNoonUTC(FIRST_DATE) + Math.floor(Math.random() * (days + 1)) * DAY);
}

export function isValidDate(d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= FIRST_DATE && d <= todayET();
}
