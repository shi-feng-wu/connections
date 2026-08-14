import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from './_admin.js';
import { fetchDiscordUser } from './_discord.js';
import { isValidDate, todayET } from './_puzzles.js';
import { fetchOwnScore, fetchStreak, mistakesOf, replayFinished } from './_share.js';
import { renderShareCard } from './_sharecard.js';

// Hand the caller their daily result card back as a DISCORD-HOSTED IMAGE URL, for the client's
// discordSdk.commands.openShareMomentDialog. The player picks a chat and what lands there is
// the picture itself — a plain image message, posted as them — rather than an embed with our
// title, our description, and a Play button. Owner call (2026-08-14): the plain picture is the
// share. /api/share-link's quick link stays underneath as the fallback (see src/App.tsx
// shareResult), because older clients don't have the dialog RPC and the quick link is the only
// path that carries referral attribution.
//
// PORTRAIT, NOT HERO. share-link ships the wide crop-safe composition because Discord scales a
// quick-link image into the embed's fixed ratio box and crops it. A share-moment picture is
// posted at its natural size like any pasted screenshot, so this route renders the bare
// portrait — the same card /api/share-image puts on the clipboard.
//
// NOTHING IS CACHED, ANYWHERE. The url Discord mints here is EPHEMERAL: it exists for one pass
// through the dialog and expires on its own, so remembering it would only mean handing a player
// a dead image on their next Share. Nor is there anything worth dedupe on Discord's side — an
// attachment upload creates no durable object and spends no mint quota, unlike a quick link —
// so every share re-renders and re-uploads. That costs one render plus one POST.
//
// THE GRID IS NEVER TAKEN FROM THE REQUEST. Identity comes from the Discord token (/users/@me,
// the api/score.ts idiom) and the result is replayed from that user's own append-only
// `progress` record, so a caller can only ever share a card of a game they actually played,
// with the result they actually got.

const ATTACHMENT_URL = (appId: string): string =>
  `https://discord.com/api/v10/applications/${appId}/attachment`;

type Upload = { ok: true; url: string } | { ok: false; status: number; body: string };

// POST the PNG to Discord's application-attachment endpoint. Authorized with the BOT token, not
// the player's: this is an app-scoped upload (nothing is attributed to the sharer and nothing is
// posted on their behalf — the dialog they open does the posting). multipart/form-data via the
// global FormData + Blob, the api/_livecard.ts sendCard idiom: no Content-Type header, so fetch
// writes the boundary itself. A non-2xx comes back with Discord's response body intact — this
// path can't be exercised without live credentials, so that text is the only diagnosis available
// from the logs.
async function uploadAttachment(
  appId: string,
  botToken: string,
  png: Buffer,
  filename: string,
): Promise<Upload> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), filename);
  const r = await fetch(ATTACHMENT_URL(appId), {
    method: 'POST',
    headers: { Authorization: `Bot ${botToken}` },
    body: form,
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return { ok: false, status: r.status, body: body.slice(0, 500) };
  }
  const j = (await r.json().catch(() => null)) as { attachment?: { url?: string } } | null;
  const url = j?.attachment?.url;
  if (!url) return { ok: false, status: r.status, body: 'no attachment.url in response' };
  return { ok: true, url };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const body = req.body ?? {};
    const date = typeof body.date === 'string' && body.date ? body.date : todayET();
    if (!isValidDate(date)) {
      res.status(400).json({ error: 'bad date' });
      return;
    }

    const accessToken = typeof body.accessToken === 'string' ? body.accessToken : '';
    const user = await fetchDiscordUser(accessToken);
    if (!user) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const appId = process.env.VITE_DISCORD_CLIENT_ID ?? '';
    const botToken = process.env.DISCORD_BOT_TOKEN ?? '';
    const db = admin();
    // Missing credentials answer in share-link's refusal shape, so the client's one branch
    // ("this route can't serve me") drops to the quick link instead of showing a failure.
    if (!appId || !botToken || !db) {
      res.status(503).json({ ok: false, reason: 'unavailable' });
      return;
    }

    // The caller's own finished game, replayed from the append-only record. A refusal answers
    // in share-link's shape, so the client can branch on one contract for every share path.
    const replay = await replayFinished(db, user.id, date);
    if (!replay.ok) {
      res.status(200).json({ ok: false, reason: replay.reason });
      return;
    }
    const { puzzle, game } = replay;

    // The card restages the end screen, so it needs the two numbers the end screen shows that
    // a replay alone can't produce: the scored points and the solve time. Both are read from
    // the player's own scores row, and both are best-effort — the card drops whichever is
    // missing instead of rendering a placeholder.
    const [{ score, durationMs }, streak] = await Promise.all([
      fetchOwnScore(db, user.id, date),
      fetchStreak(db, user.id),
    ]);
    const png = await renderShareCard({
      puzzleNo: puzzle.id,
      puzzleDate: date,
      grid: game.history,
      solved: game.status === 'won',
      mistakes: mistakesOf(game),
      streak,
      score,
      durationMs,
    });

    const uploaded = await uploadAttachment(appId, botToken, png, `disconnections-${date}.png`);
    if (!uploaded.ok) {
      // Greppable: the picture path dies here if Discord's contract moves, and the client
      // silently drops to the quick link — so the logs are the only place this is visible.
      console.error('[share-moment] attachment upload failed', uploaded.status, uploaded.body);
      res.status(502).json({ ok: false, reason: 'upload-failed' });
      return;
    }
    res.status(200).json({ ok: true, url: uploaded.url });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
