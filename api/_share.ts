import type { SupabaseClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { COPY } from '../src/discord-copy.js';
import { fill } from '../src/copy-util.js';
import { Game, MAX_MISTAKES } from '../src/game.js';
import { fetchPuzzle, isValidDate, type Puzzle } from './_puzzles.js';
import { MAX_GUESSES } from './_scoring.js';

// Shared plumbing for the SHARE-CARD LOOP: minting a Discord quick link out of a player's
// daily result (/api/share-link) and reading the attribution back when someone opens the
// Activity from one (/api/referral). Rendering lives in _sharecard.ts and is imported ONLY by
// the mint route — /api/referral runs on the boot path and must not pull @napi-rs/canvas into
// its bundle, which is why these pure/DB pieces live here rather than in the route file.
// Leading underscore keeps Vercel from treating this file as a route.

// Discord's quick links expire 30 days after minting. We re-mint a day before that, so a
// cached URL handed to a player is never one about to 404 mid-share.
export const SHARE_LINK_TTL_DAYS = 30;
export const SHARE_LINK_REMINT_MS = 29 * 24 * 60 * 60 * 1000;

// Abuse guard: a real player shares today's result, occasionally yesterday's. Minting is a
// render plus a Discord write, so cap how many DISTINCT dates one account can mint per day.
// A re-share of an already-minted date is served from the cache and never counts (the cache
// check runs first), so this only ever stops someone walking the archive.
export const MAX_SHARE_DATES_PER_DAY = 5;

const QUICK_LINKS_URL = (appId: string): string =>
  `https://discord.com/api/v10/applications/${appId}/quick-links`;

// "This table doesn't exist yet." share_links/referrals ship in the same change as these
// routes, so a deploy that lands before the SQL is applied must still be able to SHARE — it
// just can't cache. Every touch below treats it as "no cache today". Two codes because
// PostgREST usually answers a table it can't see from its schema cache (PGRST205) rather than
// letting Postgres raise the raw 42P01; the behaviour is identical either way, this only
// decides which log line fires.
export const UNDEFINED_TABLE = '42P01';
export function isMissingTable(code: string | undefined): boolean {
  return code === UNDEFINED_TABLE || code === 'PGRST205';
}

// custom_id rides on the shared URL and comes back at the recipient's boot, so keep it
// compact: "<sharer id>/<yyyymmdd>". The docs state no length limit, but the value is
// user-visible in a URL, so short is right.
export function shareCustomId(userId: string, date: string): string {
  return `${userId}/${date.replace(/-/g, '')}`;
}

// Inverse of shareCustomId. Returns null for anything that isn't one of ours — a custom_id
// can also come from a STATIC dev-portal campaign link, which /api/referral records verbatim
// rather than pretending to parse.
export function parseShareCustomId(customId: unknown): { userId: string; date: string } | null {
  if (typeof customId !== 'string') return null;
  const m = /^(\d{5,25})\/(\d{4})(\d{2})(\d{2})$/.exec(customId);
  return m ? { userId: m[1], date: `${m[2]}-${m[3]}-${m[4]}` } : null;
}

// ——— PERMANENT CARD URLS: the token behind https://disconnections.app/i/<token>.png ———
//
// Every other way a card leaves this app hands out a link with a clock on it. Discord's
// quick-link image and the share-moment attachment are both SIGNED CDN urls that expire, so a
// card pasted somewhere durable — a forum, a group chat someone scrolls back through, a blog —
// eventually rots into a broken image. This one doesn't: the token names a (player, date), and
// /api/share-png RE-RENDERS the card from the append-only record on every request. A finished
// result is immutable, so the same token always draws the same card, for as long as the app is
// up.
//
// NO TABLE, DELIBERATELY. The token IS the record: `<userId>.<yyyymmdd>.<sig>`, where sig is a
// truncated HMAC over the pair. That's what makes the url non-enumerable without paying for a
// row (and a write, on the end screen's critical path) per share: you can't mint a link to
// someone else's result by editing an id or walking dates out of a link you were handed.
//
// INTERNAL_SECRET is the signing key ON PURPOSE. It's a server-only secret that never leaves a
// function and is already set in production, which is the whole requirement — the same shape as
// SESSION_SECRET in _session.ts. Its other job (authenticating our function-to-function
// self-calls) is the same job in different clothes: prove this came from us.
//
// 20 hex chars = 80 bits of signature. Short enough to keep the url pasteable, hopelessly far
// past what anyone could grind against a route that renders a PNG per attempt.
const SHARE_PNG_SIG_LEN = 20;
const SHARE_PNG_TOKEN_RE = new RegExp(
  `^(\\d{5,25})\\.(\\d{4})(\\d{2})(\\d{2})\\.([0-9a-f]{${SHARE_PNG_SIG_LEN}})$`,
);

// Read at call time, not at module load: a route can be imported before the env is in place,
// and the tests toggle it between assertions.
const sharePngSig = (userId: string, date: string): string =>
  createHmac('sha256', process.env.INTERNAL_SECRET ?? '')
    .update(`share-png:${userId}:${date}`)
    .digest('hex')
    .slice(0, SHARE_PNG_SIG_LEN);

// The token for one player's result on one date. Signed over the yyyy-mm-dd date (the form the
// rest of the server speaks); the token carries the compact yyyymmdd, like shareCustomId.
export function sharePngToken(userId: string, date: string): string {
  return `${userId}.${date.replace(/-/g, '')}.${sharePngSig(userId, date)}`;
}

// Where those tokens live. Absolute and hard-coded on purpose: the url is handed to OTHER
// people's clients (a clipboard paste, a Discord embed Discord's proxy fetches server-side), so
// it can never be relative, and a preview deployment must still emit the production origin —
// a link that outlives the deploy that minted it is the entire point of this pair.
const SHARE_PNG_ORIGIN = 'https://disconnections.app';

// The permanent url for one player's result. The single place the origin/path/extension are
// assembled, so /api/share-url (the end screen's "Copy link") and /api/post-share (the /share
// command's embed) can never drift apart on the shape /api/share-png is rewritten to serve.
export function sharePngUrl(userId: string, date: string): string {
  return `${SHARE_PNG_ORIGIN}/i/${sharePngToken(userId, date)}.png`;
}

// Inverse of sharePngToken. Null for anything that isn't one of ours — a wrong shape, a date
// that isn't a real puzzle day, or a signature that doesn't re-derive. The comparison is
// constant-time over the raw signature bytes, so a forger learns nothing from how long a 404
// took. An unset INTERNAL_SECRET can't verify anything, so it refuses rather than signing with
// the empty string (the caller answers 503 — see /api/share-png).
export function parseSharePngToken(token: unknown): { userId: string; date: string } | null {
  if (!process.env.INTERNAL_SECRET || typeof token !== 'string') return null;
  const m = SHARE_PNG_TOKEN_RE.exec(token);
  if (!m) return null;
  const userId = m[1];
  const date = `${m[2]}-${m[3]}-${m[4]}`;
  if (!isValidDate(date)) return null;
  const sig = Buffer.from(m[5], 'hex');
  const expected = Buffer.from(sharePngSig(userId, date), 'hex');
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  return { userId, date };
}

// The result phrase, e.g. "solved with 1 mistake". Counts and outcomes only — never a word, a
// category, or a group — so the prefilled message stays as spoiler-free as the card.
export function shareResultPhrase(solved: boolean, mistakes: number): string {
  if (!solved) return COPY['share-link.result-lost'];
  if (mistakes <= 0) return COPY['share-link.result-perfect'];
  return fill(COPY['share-link.result-solved'], { mistakes, s: mistakes === 1 ? '' : 's' });
}

// The line prefilled into Discord's share modal, e.g. "Disconnections #1170: solved with 1
// mistake". The player can edit it before sending.
export function shareMessage(
  puzzleNo: number | null | undefined,
  solved: boolean,
  mistakes: number,
): string {
  const result = shareResultPhrase(solved, mistakes);
  return fill(COPY['share-link.message'], { puzzle: puzzleNo ?? '', result })
    .replace(' #:', ':') // no puzzle number -> don't leave a bare " #"
    .trim();
}

// The URL Discord's share modal posts, rebuilt from the pieces so we can hand it to the
// clipboard fallback. Discord's POST answers with the link_id alone; the activity-URL shape
// (referrer_id + custom_id + link_id) is what the platform's referral docs specify.
export function quickLinkUrl(
  appId: string,
  userId: string,
  customId: string,
  linkId: string,
): string {
  const q = new URLSearchParams({ referrer_id: userId, custom_id: customId, link_id: linkId });
  return `https://discord.com/activities/${appId}?${q.toString()}`;
}

// Midnight ET as a UTC instant — the same day boundary the daily puzzle resets on, so the mint
// quota resets with the puzzle rather than on a rolling clock. Derived from the ET wall clock
// at `now`, so EDT/EST is handled without a tz table.
export function etMidnightIso(now: Date = new Date()): string {
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const offsetMs = now.getTime() - et.getTime();
  et.setHours(0, 0, 0, 0);
  return new Date(et.getTime() + offsetMs).toISOString();
}

export type CachedLink = { link_id: string; url: string };

// The already-minted link for this (user, date), if there is one and it isn't near expiry. A
// second Share click must reuse it: minting again would burn quota, spend a render and a
// Discord write, and hand out a second link for the same result.
export async function loadCachedShareLink(
  db: SupabaseClient,
  userId: string,
  date: string,
  now: number = Date.now(),
): Promise<CachedLink | null> {
  const { data, error } = await db
    .from('share_links')
    .select('link_id, url, created_at')
    .eq('user_id', userId)
    .eq('puzzle_date', date)
    .maybeSingle();
  if (error) {
    if (isMissingTable(error.code)) console.warn('[share-link] share_links missing; minting uncached');
    return null;
  }
  if (!data?.link_id || !data?.url) return null;
  const at = Date.parse(String(data.created_at ?? ''));
  // Unparseable/absent timestamp -> treat as fresh. The worst case is one stale link; re-minting
  // on every click would be worse.
  if (!Number.isNaN(at) && now - at > SHARE_LINK_REMINT_MS) return null;
  return { link_id: String(data.link_id), url: String(data.url) };
}

// How many distinct dates this account has minted since midnight ET. One row per date (the PK
// is (user_id, puzzle_date)), so a row count IS the distinct-date count. Returns 0 when the
// table isn't there yet — an uncacheable deploy shouldn't also be un-shareable.
export async function countMintedToday(
  db: SupabaseClient,
  userId: string,
  sinceIso: string,
): Promise<number> {
  const { count, error } = await db
    .from('share_links')
    .select('puzzle_date', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', sinceIso);
  if (error) return 0;
  return count ?? 0;
}

// Remember a freshly minted link so the next Share click reuses it. Best-effort: a missing
// table, or a concurrent mint that already wrote the row, must not fail the share the player
// is in the middle of.
export async function saveShareLink(
  db: SupabaseClient,
  row: { user_id: string; puzzle_date: string; link_id: string; url: string },
  now: Date = new Date(),
): Promise<void> {
  // created_at is written EXPLICITLY, not left to the column default: an upsert only sets the
  // columns it is given, so on the conflict path (a re-mint after the 30-day TTL) the default
  // never fires and the row would keep its original timestamp — leaving it permanently past
  // the re-mint threshold, so every later Share click would mint again. That is precisely the
  // render-plus-Discord-write the cache exists to avoid.
  const { error } = await db
    .from('share_links')
    .upsert({ ...row, created_at: now.toISOString() }, { onConflict: 'user_id,puzzle_date' });
  if (error) console.warn('[share-link] cache write failed', error.code ?? error.message);
}

export type MintResult = { ok: true; linkId: string } | { ok: false; status: number; body: string };

// POST the card to Discord's quick-links endpoint. Authorized with the PLAYER'S OAuth token
// (per the platform docs — this is a user-scoped link, not a bot action), so the link is
// attributed to them and Discord can stamp referrer_id. The image goes as a base64 data URI,
// Discord's usual image-data shape. A non-2xx comes back with Discord's response body intact:
// this path can't be exercised without a live token, so that text is the only way to diagnose
// it from the logs.
export async function mintQuickLink(
  appId: string,
  accessToken: string,
  opts: { title: string; description: string; customId: string; png: Buffer },
): Promise<MintResult> {
  const r = await fetch(QUICK_LINKS_URL(appId), {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      custom_id: opts.customId,
      // Quick-link copy limits are MUCH tighter than embeds — Discord 400s the whole mint
      // past them (observed live 2026-08-14: title 1-32, description 1-64). Clamp here so a
      // future copy edit (or a long interpolated value) degrades to a truncated line instead
      // of killing every share.
      title: opts.title.slice(0, 32),
      description: opts.description.slice(0, 64),
      image: `data:image/png;base64,${opts.png.toString('base64')}`,
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return { ok: false, status: r.status, body: body.slice(0, 500) };
  }
  const j = (await r.json().catch(() => null)) as { link_id?: string } | null;
  if (!j?.link_id) return { ok: false, status: r.status, body: 'no link_id in response' };
  return { ok: true, linkId: j.link_id };
}

export type Replay =
  | { ok: true; puzzle: Puzzle; game: Game }
  | { ok: false; reason: 'no-progress' | 'no-puzzle' | 'not-finished' };

// Replay one player's finished game for a date from their own append-only `progress` record —
// the SAME record /api/score scores from, which is what makes the card unfakeable from the
// request. Both the mint path and the cache-hit path go through here, so they can never
// disagree about what the result was.
export async function replayFinished(
  db: SupabaseClient,
  userId: string,
  date: string,
): Promise<Replay> {
  const { data } = await db
    .from('progress')
    .select('guesses, hints')
    .eq('user_id', userId)
    .eq('puzzle_date', date)
    .maybeSingle();
  const committed: unknown = data?.guesses;
  if (!Array.isArray(committed) || committed.length === 0) return { ok: false, reason: 'no-progress' };
  let puzzle: Puzzle;
  try {
    puzzle = await fetchPuzzle(date, db);
  } catch {
    return { ok: false, reason: 'no-puzzle' };
  }
  const game = Game.fromGuesses(puzzle, committed.slice(0, MAX_GUESSES), undefined, data?.hints);
  if (game.status === 'playing') return { ok: false, reason: 'not-finished' };
  return { ok: true, puzzle, game };
}

// Mistakes spent in a finished replay (the card's dots and the message's count).
export function mistakesOf(game: Game): number {
  return MAX_MISTAKES - game.mistakesLeft;
}

// The player's own leaderboard row for a date: the score and the solve time the end screen
// shows. Looked up by user + date ONLY, never by the room the share happens in — `scores`
// keeps ONE row per (puzzle, user), pinned to the scope where they FIRST finished, so
// filtering by scope would miss it (the same bug the /share command hit). These can't be
// recomputed from the replay: a server-side Game.fromGuesses has no start time, so its speed
// bonus would be zero and its score wrong. Either field may be absent (never scored, or an
// older row with no duration) — the card DROPS a missing stat rather than inventing one.
export async function fetchOwnScore(
  db: SupabaseClient,
  userId: string,
  date: string,
): Promise<{ score: number | null; durationMs: number | null }> {
  try {
    const { data } = await db
      .from('scores')
      .select('score, duration_ms')
      .eq('user_id', userId)
      .eq('puzzle_date', date)
      .maybeSingle();
    return {
      score: typeof data?.score === 'number' ? data.score : null,
      durationMs: typeof data?.duration_ms === 'number' ? data.duration_ms : null,
    };
  } catch {
    return { score: null, durationMs: null };
  }
}

// The prefilled share-modal line for a replayed game.
export function messageFor(puzzle: Puzzle, game: Game): string {
  return shareMessage(puzzle.id, game.status === 'won', mistakesOf(game));
}

// The player's current daily streak, for the card's "N day streak" line. Best-effort: the
// streak is decoration, so any failure just drops the line.
export async function fetchStreak(db: SupabaseClient, userId: string): Promise<number | null> {
  try {
    const { data, error } = await db.rpc('user_streak', { p_user: userId });
    return !error && typeof data === 'number' ? data : null;
  } catch {
    return null;
  }
}
