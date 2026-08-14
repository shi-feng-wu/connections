import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { COPY } from "../src/discord-copy.js";
import { IS_COMPONENTS_V2, shareCard } from "../src/discord-messages.js";
import type { Game } from "../src/game.js";
import { interactionMessageUrl, sendCard } from "./_livecard.js";
import { isValidDate } from "./_puzzles.js";
import { fetchOwnScore, fetchStreak, mistakesOf, replayFinished } from "./_share.js";

// The /share RENDER, split out of /api/interactions exactly the way the "who's playing" card is
// (see api/post-card.ts). /api/interactions must never carry @napi-rs/canvas: it is the
// latency-critical function Discord holds to a 3s deadline, and the native addon would bloat its
// cold start. So /share now ANSWERS there (a public DEFERRED response — Discord shows "thinking…")
// and fires a fire-and-forget internal call here; this function replays the game, renders the
// portrait card, and edits the deferred message into the picture.
//
// Authenticated by INTERNAL_SECRET (the post-card idiom), NOT the Discord signature — that was
// already verified upstream, and the secret proves the call came from our own function.
//
// THE GRID IS NEVER TAKEN FROM THE REQUEST. The caller hands us a user id and a date; the result is
// replayed from that user's own append-only `progress` record (api/_share.ts replayFinished), the
// same source /api/score scores from. A forged internal call still can't invent a result.
//
// PORTRAIT, NOT HERO. Same crop-free composition /api/share-moment posts and /api/share-image puts
// on the clipboard — a Discord attachment is shown at its natural size, so there's nothing to
// crop-proof (the wide hero exists only for the quick link's fixed embed ratio).
//
// NEVER WORSE THAN IT WAS. /share used to answer inline with the emoji-square Components V2 card.
// If anything here fails before the picture lands — the render throws, the replay is gone, Discord
// refuses the attachment — we edit the deferred message into THAT card instead, so the worst case
// is the message players got yesterday rather than a "thinking…" that never resolves.

// The deferred interaction response itself, editable on the interaction token for ~15 min.
const ORIGINAL = "@original";

type ShareJob = {
  token?: string;
  userId?: string;
  date?: string;
  appId?: string;
};

// Non-2xx statuses Discord hands back that are EXPECTED rather than bugs: 404 = the interaction
// token expired or the message was deleted before this background render finished; 429 = rate
// limited. Warn on those so the runtime-errors view stays a list of real problems (mirrors
// post-card's cardLog).
const shareLog = (status: number): ((...args: unknown[]) => void) =>
  status === 404 || status === 429 ? console.warn : console.error;

// Edit the deferred response into a plain JSON message. Used for both degraded outcomes: the
// emoji-square card (the fallback proper) and the apology when there's no game to draw at all.
// Any failure here is terminal — we've spent the message — so it is logged under a greppable
// '[post-share]' with Discord's status AND body, and then we give up quietly.
async function patchOriginal(url: string, payload: object, what: string): Promise<boolean> {
  const r = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    shareLog(r.status)(
      `[post-share] ${what} edit failed`,
      { status: r.status },
      await r.text().catch(() => ""),
    );
    return false;
  }
  return true;
}

// The pre-image /share message: the Components V2 emoji-square card, built by the SAME builder the
// inline reply used (src/discord-messages.ts shareCard), so the fallback is bit-for-bit the message
// /share posted before this change.
async function patchFallbackCard(
  url: string,
  game: Game,
  opts: { puzzleNo?: number; durationMs: number | null; score: number | null },
): Promise<void> {
  await patchOriginal(
    url,
    { flags: IS_COMPONENTS_V2, components: shareCard(game, opts) },
    "fallback card",
  );
}

async function postShare(job: ShareJob): Promise<void> {
  const appId = job.appId || process.env.VITE_DISCORD_CLIENT_ID || "";
  const token = typeof job.token === "string" ? job.token : "";
  const userId = typeof job.userId === "string" ? job.userId : "";
  const date = typeof job.date === "string" ? job.date : "";
  // Nothing to edit without a token, and nothing to look up without a user/date. Bail before any
  // DB or render work — there is no message to degrade into, either.
  if (!appId || !token || !userId || !isValidDate(date)) {
    console.warn("[post-share] skip: incomplete job", {
      hasAppId: !!appId,
      hasToken: !!token,
      hasUser: !!userId,
      date,
    });
    return;
  }
  const url = interactionMessageUrl(appId, token, ORIGINAL);

  const { admin } = await import("./_admin.js");
  const db = admin();
  if (!db) {
    console.error("[post-share] no db (admin client unconfigured)");
    await patchOriginal(url, { content: COPY["share.build-failed"] }, "apology");
    return;
  }

  // The player's own finished game, replayed from the append-only record. /api/interactions already
  // ran this check before it deferred, so a failure here means the row vanished underneath us (or
  // the puzzle fetch broke) — rare, but it leaves us with no game to draw AND no game to build the
  // emoji card from, so the only honest edit is the apology.
  const replay = await replayFinished(db, userId, date);
  if (!replay.ok) {
    console.warn("[post-share] replay unavailable", { user: userId, date, reason: replay.reason });
    await patchOriginal(url, { content: COPY["share.build-failed"] }, "apology");
    return;
  }
  const { puzzle, game } = replay;

  // The card restages the end screen, so it needs the two numbers a replay can't produce (a
  // server-side replay has no start time, so its speed bonus — and therefore its score — would be
  // wrong): the scored points and the solve time, read from the player's own scores row. Both are
  // best-effort and both feed the fallback card too, which is why they're fetched before the
  // render rather than inside it. The streak is decoration for the picture only.
  const [{ score, durationMs }, streak] = await Promise.all([
    fetchOwnScore(db, userId, date),
    fetchStreak(db, userId),
  ]);
  const cardOpts = { puzzleNo: puzzle.id, durationMs, score };

  // Canvas is loaded HERE, lazily, so a broken/missing native addon surfaces as a caught throw that
  // degrades to the emoji card rather than a module-load crash that leaves the message hanging.
  let png: Buffer | null = null;
  try {
    const { renderShareCard } = await import("./_sharecard.js");
    png = await renderShareCard({
      puzzleNo: puzzle.id,
      puzzleDate: date,
      grid: game.history,
      solved: game.status === "won",
      mistakes: mistakesOf(game),
      streak,
      score,
      durationMs,
    });
  } catch (e) {
    console.error("[post-share] render threw", e instanceof Error ? e.message : e);
  }

  if (png) {
    // Multipart edit of the deferred response: payload_json names the attachment, files[0] carries
    // the bytes (the api/_livecard.ts sendCard idiom — no Content-Type header, so fetch writes the
    // boundary itself). The filename is what a player sees when they save the picture.
    const filename = `disconnections-${date}.png`;
    const r = await sendCard(url, { attachments: [{ id: 0, filename }] }, png, "PATCH", filename);
    if (r.ok) {
      console.log("[post-share] posted image", { user: userId, date, bytes: png.length });
      return;
    }
    // Discord refused the picture — the message is still ours to fill, so fall through to the card
    // /share used to post rather than leaving a dead "thinking…".
    shareLog(r.status)(
      "[post-share] image edit failed; falling back to the components card",
      { status: r.status },
      await r.text().catch(() => ""),
    );
  }

  await patchFallbackCard(url, game, cardOpts);
}

// Internal endpoint: /api/interactions defers the /share reply, then calls this (server-to-server)
// with the verified invoker's id and the interaction token. We authenticate with INTERNAL_SECRET,
// ACK fast, then render + edit the deferred message in the background.
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const secret = process.env.INTERNAL_SECRET ?? "";
  if (!secret || req.headers["authorization"] !== `Bearer ${secret}`) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  const body = (req.body ?? {}) as ShareJob;
  // ACK the internal caller immediately so /api/interactions isn't held open; the render runs in
  // this function's own background.
  res.status(200).json({ ok: true });
  waitUntil(
    postShare(body).catch((e) => {
      console.error("[post-share] threw", e instanceof Error ? e.message : e);
    }),
  );
}
