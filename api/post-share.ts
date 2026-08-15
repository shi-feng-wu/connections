import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { COPY } from "../src/discord-copy.js";
import { IS_COMPONENTS_V2, shareCard } from "../src/discord-messages.js";
import type { Game } from "../src/game.js";
import { interactionMessageUrl } from "./_livecard.js";
import { isValidDate } from "./_puzzles.js";
import { PLAY_CUSTOM_ID } from "./_recap.js";
import { fetchOwnScore, replayFinished, sharePngUrl } from "./_share.js";

// The /share ANSWER, split out of /api/interactions exactly the way the "who's playing" card is
// (see api/post-card.ts). /api/interactions is the latency-critical function Discord holds to a 3s
// deadline, so /share ANSWERS there (a public DEFERRED response — Discord shows "thinking…") and
// fires a fire-and-forget internal call here; this function checks the result really exists and
// edits the deferred message into a picture of it.
//
// A LINK, NOT AN UPLOAD. The edit is a bare image EMBED pointing at the player's PERMANENT card url
// (https://disconnections.app/i/<token>.png — api/share-png, see _share.ts for the token). We used
// to render the PNG here and PATCH it up as a multipart attachment; pointing at the url is strictly
// better on every axis:
//   - No bytes cross this function. No canvas, no fonts to bundle (hence no includeFiles entry in
//     vercel.json), no native addon in the cold start, no PNG upload to Discord per /share.
//   - Discord's camo proxy fetches our origin ONCE and serves every viewer a cached webp, so the
//     cost of a popular share is one render, not one upload plus N Discord CDN reads — and the
//     picture arrives smaller than the PNG we would have posted.
//   - The message implicitly CARRIES the durable link. An attachment's CDN url expires; this embed
//     still resolves months later, and anyone can lift the url out of the message and paste it
//     anywhere. That's the share loop the attachment quietly dead-ended.
// The visual is unchanged where it matters: an image-only embed is chrome-free — just the picture,
// none of the title/description furniture a quick-link embed carries.
//
// AND A PLAY BUTTON UNDER IT (2026-08-15). The picture alone was a dead end for the one person the
// share exists to reach: someone in the channel who does NOT already play. Clicking the image opens
// Discord's media viewer, not us, and the url it wraps goes to a browser — asking a reader to leave
// Discord in order to come back into it. The button is the same `connections_play` the "who's
// playing" card and the recap have carried all along, so /api/interactions already answers it with
// LAUNCH_ACTIVITY: one tap, the Activity opens in that channel, nobody leaves the app.
//
// It costs the message's parity with a PASTED link, which cannot carry components (Discord won't
// let us decorate someone else's message) — the owner's 2026-08-14 call that the two look identical
// is knowingly traded here for the only native conversion affordance we have. The unfurl itself is
// untouched: content is still the bare url, so the picture renders at exactly the size it always
// did, and the button is a row beneath it rather than a change to the card.
//
// Authenticated by INTERNAL_SECRET (the post-card idiom), NOT the Discord signature — that was
// already verified upstream, and the secret proves the call came from our own function. The same
// secret SIGNS the permanent url, so a deploy that has one has both.
//
// THE GRID IS NEVER TAKEN FROM THE REQUEST. The caller hands us a user id and a date; the result is
// replayed from that user's own append-only `progress` record (api/_share.ts replayFinished), the
// same source /api/score scores from — and /api/share-png replays it AGAIN before it draws. We
// still replay here, before emitting anything, so /share for a game that was never finished says so
// rather than posting a url that 404s into a broken image.
//
// NEVER WORSE THAN IT WAS. /share used to answer inline with the emoji-square Components V2 card.
// If anything here fails before the picture lands — the replay is gone, there's no signing key,
// Discord refuses the embed — we edit the deferred message into THAT card instead, so the worst
// case is the message players got yesterday rather than a "thinking…" that never resolves.

// The deferred interaction response itself, editable on the interaction token for ~15 min.
const ORIGINAL = "@original";

type ShareJob = {
  token?: string;
  userId?: string;
  date?: string;
  appId?: string;
};

// Non-2xx statuses Discord hands back that are EXPECTED rather than bugs: 404 = the interaction
// token expired or the message was deleted before this background job finished; 429 = rate
// limited. Warn on those so the runtime-errors view stays a list of real problems (mirrors
// post-card's cardLog).
const shareLog = (status: number): ((...args: unknown[]) => void) =>
  status === 404 || status === 429 ? console.warn : console.error;

// Edit the deferred response into a JSON message: the image embed (the good outcome) and both
// degraded ones — the emoji-square card (the fallback proper) and the apology when there's no game
// to point at at all. A failure is logged under a greppable '[post-share]' with Discord's status
// AND body; the embed caller falls back on `false`, the degraded callers have nothing left to try.
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

// The one row every /share message carries, whichever branch built it: the Activity launcher. Its
// custom_id is the shared `connections_play` — routeInteraction already turns that into
// LAUNCH_ACTIVITY for the card and the recap, so this button needs nothing new on the handler side.
// A plain ActionRow is legal at the top level of a Components V2 message too, which is why the
// fallback can append it to shareCard's container without the builder knowing.
const playRow = { type: 1, components: [{ type: 2, style: 1, label: COPY["button.play"], custom_id: PLAY_CUSTOM_ID }] };

// The pre-image /share message: the Components V2 emoji-square card, built by the SAME builder the
// inline reply used (src/discord-messages.ts shareCard), so the fallback is bit-for-bit the message
// /share posted before this change — plus the play row, which every share surface now carries.
async function patchFallbackCard(
  url: string,
  game: Game,
  opts: { puzzleNo?: number; durationMs: number | null; score: number | null },
): Promise<void> {
  await patchOriginal(
    url,
    { flags: IS_COMPONENTS_V2, components: [...shareCard(game, opts), playRow] },
    "fallback card",
  );
}

async function postShare(job: ShareJob): Promise<void> {
  const appId = job.appId || process.env.VITE_DISCORD_CLIENT_ID || "";
  const token = typeof job.token === "string" ? job.token : "";
  const userId = typeof job.userId === "string" ? job.userId : "";
  const date = typeof job.date === "string" ? job.date : "";
  // Nothing to edit without a token, and nothing to look up without a user/date. Bail before any DB
  // work — there is no message to degrade into, either.
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
  // the puzzle fetch broke) — rare, but it leaves us with no result to point at AND no game to build
  // the emoji card from, so the only honest edit is the apology.
  const replay = await replayFinished(db, userId, date);
  if (!replay.ok) {
    console.warn("[post-share] replay unavailable", { user: userId, date, reason: replay.reason });
    await patchOriginal(url, { content: COPY["share.build-failed"] }, "apology");
    return;
  }
  const { puzzle, game } = replay;

  // The url is an HMAC over (user, date) — worthless without the signing key, and sharePngToken
  // would happily sign with the empty string, minting a link /api/share-png refuses to verify. The
  // route's own auth already needed INTERNAL_SECRET to let this call in, so this can only fire if
  // the key went missing underneath us; a permanently broken image is worse than yesterday's card,
  // so check rather than assume.
  if (process.env.INTERNAL_SECRET) {
    // The message IS the link, nothing else — the exact shape a player pasting the url produces.
    // Discord unfurls a lone image link into the full-size standalone media preview and hides the
    // link text; an explicit {embeds:[{image}]} instead renders in the EMBED layout's smaller
    // media box, which made /share output visibly smaller than a pasted link beside it (owner
    // call, 2026-08-14: they must look identical). The proxy still fetches /i/<token>.png once
    // server-side, so this PATCH carries a few dozen bytes no matter who scrolls past.
    //
    // The components row rides alongside and does NOT disturb that: Discord unfurls off `content`,
    // so the preview is byte-identical to the pasted-link one and the button lands in its own row
    // underneath.
    const ok = await patchOriginal(
      url,
      { content: sharePngUrl(userId, date), components: [playRow] },
      "image link",
    );
    if (ok) {
      console.log("[post-share] posted image link", { user: userId, date });
      return;
    }
    // Discord refused the edit — the message is still ours to fill, so fall through to the card
    // /share used to post rather than leaving a dead "thinking…".
  } else {
    console.error("[post-share] no INTERNAL_SECRET to sign the card url; falling back to the card");
  }

  // Fallback only, and only now: the emoji card restages the end screen, so it needs the two
  // numbers a replay can't produce (a server-side replay has no start time, so its speed bonus —
  // and therefore its score — would be wrong). The embed path never reads them, because whoever
  // opens the url makes /api/share-png look them up itself. Best-effort; a missing stat is dropped.
  const { score, durationMs } = await fetchOwnScore(db, userId, date);
  await patchFallbackCard(url, game, { puzzleNo: puzzle.id, durationMs, score });
}

// Internal endpoint: /api/interactions defers the /share reply, then calls this (server-to-server)
// with the verified invoker's id and the interaction token. We authenticate with INTERNAL_SECRET,
// ACK fast, then verify the result and edit the deferred message in the background.
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
  // ACK the internal caller immediately so /api/interactions isn't held open; the replay + edit run
  // in this function's own background.
  res.status(200).json({ ok: true });
  waitUntil(
    postShare(body).catch((e) => {
      console.error("[post-share] threw", e instanceof Error ? e.message : e);
    }),
  );
}
