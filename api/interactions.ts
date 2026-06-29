import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createPublicKey, verify as edVerify } from "node:crypto";
import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  donateMessage,
  enablePostsAddBot,
  enablePostsAlreadyEnabled,
  EPHEMERAL,
  installNudgePayload,
  IS_COMPONENTS_V2,
  missingPermsNudgePayload,
  shareCard,
  unsubscribeResult,
} from "../src/discord-messages.js";
import { COPY } from "../src/discord-copy.js";
import { fill } from "../src/copy-util.js";
import { Game, type Puzzle } from "../src/game.js";
import { canonicalScope } from "../src/scope.js";
import { internalBase } from "./_internal.js";
import { PLAY_CUSTOM_ID } from "./_recap.js";

// This is the latency-critical function: Discord enforces a ~3s deadline on the launch ACK, and the
// first request after a deploy is cold. So it is kept DELIBERATELY TINY — it imports no canvas
// (@napi-rs/canvas) and no card plumbing. The "who's playing" render lives in /api/post-card, which
// this function triggers (fire-and-forget) AFTER the ACK. /share and /unsubscribe still answer here
// synchronously and lazy-import the Supabase SDK (_admin/_nyt) so the launch ACK never pays for it.

// Discord interactions webhook. Discord POSTs here for: the typed /connections command,
// the App-Launcher Entry Point command, the card/recap "Play now!" button, and a PING.
//
// A launch command is answered with LAUNCH_ACTIVITY (the game auto-opens) — we send that ACK
// ourselves (APP_HANDLER), so Discord never posts its own Game Invitation card; only our custom
// card appears, rendered by /api/post-card. (A LAUNCH_ACTIVITY response leaves a "<user> used
// /connections" line, so the followup card lands just under it.)
//
// Every request is Ed25519-signed; an unverified request must get a 401 (Discord
// rejects the endpoint at setup time otherwise). The signature covers the exact
// request bytes, so the body parser is disabled and the raw stream is read.

export const config = { api: { bodyParser: false } };

// Discord interaction + callback type numbers we use. The message flags + Components V2
// type numbers, and the message payload builders themselves, live in src/discord-messages.ts
// (node-free) so the offline preview harness renders the exact same messages.
const PING = 1;
const APPLICATION_COMMAND = 2;
const MESSAGE_COMPONENT = 3;
const PONG = 1;
const LAUNCH_ACTIVITY = 12;

// Command names that should open the Activity. Both the Entry Point command (App Launcher)
// and the chat-input command arrive as APPLICATION_COMMAND interactions named `connections`.
// `play` is kept as an alias in case `connections` collides with the Entry Point command
// name at registration time.
const LAUNCH_COMMANDS = new Set(["connections", "play"]);

// The "/enable-posts" command: in a server without the bot it replies (privately) with a
// one-click "Add to Server" button — the only way recaps and the live card can post there.
const ENABLE_POSTS_COMMAND = "enable-posts";
// The "/share" command (mirrors Wordle's share): posts the player's finished result grid —
// one row of category-colour squares per guess — publicly to the channel. Computed from the
// player's stored guesses (a DB read), so it's handled off the pure router (see shareResponse).
const SHARE_COMMAND = "share";
// The "/donate" command: replies (privately) with a Ko-fi link button — the same one in the
// app footer. Connections is free and ad-free; donations cover the server costs. KEEP the URL
// in sync with the Ko-fi link in src/infolinks.tsx.
const DONATE_COMMAND = "donate";
// The "/unsubscribe" command: a moderator silences the daily recap in the channel it's run in.
// It writes a recap_optouts row that recap_channels() subtracts, so the nightly cron skips this
// channel — until someone launches the Activity here again, which clears the row (see post-card).
// Registered guild-install only + Manage Channels gated (scripts/register-commands.mjs), so it
// only appears where the bot can post recaps and only for members who can configure the channel.
const UNSUBSCRIBE_COMMAND = "unsubscribe";

// The message payload builders + their flags/constants live in src/discord-messages.ts
// (node-free, shared with the preview harness). Re-exported below so existing importers
// (tests, callers) keep their import path.
export {
  installNudgePayload,
  missingPermsNudgePayload,
  shareCard,
  unsubscribeResult,
};

// 32-byte raw Ed25519 public key -> a KeyObject, via the fixed SPKI DER prefix.
// crypto can't ingest the bare key, but wrapping it in the standard Ed25519 SPKI
// header is exact and avoids pulling in a dependency.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyDiscordSig(
  rawBody: string,
  sigHex: string,
  timestamp: string,
  publicKeyHex: string,
): boolean {
  if (!publicKeyHex || !sigHex || !timestamp) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    // Ed25519 takes a null algorithm; message is timestamp + raw body.
    return edVerify(
      null,
      Buffer.from(timestamp + rawBody),
      key,
      Buffer.from(sigHex, "hex"),
    );
  } catch {
    return false;
  }
}

type Interaction = {
  type?: number;
  data?: { custom_id?: string; name?: string };
  application_id?: string;
  guild_id?: string;
  authorizing_integration_owners?: Record<string, string>;
};

// Whether this interaction is a launch command (slash or Entry Point) — launches AND posts
// the card as an interaction followup.
function isLaunchCommand(body: Interaction): boolean {
  return (
    body.type === APPLICATION_COMMAND &&
    LAUNCH_COMMANDS.has(body.data?.name ?? "")
  );
}

// The card/recap "Play now!" button — launches AND posts a card replying to the clicked
// message (the click interaction hands us that message in body.message).
function isPlayButton(body: Interaction): boolean {
  return (
    body.type === MESSAGE_COMPONENT && body.data?.custom_id === PLAY_CUSTOM_ID
  );
}

// The "/share" slash command — posts the player's result grid for today's puzzle.
function isShareCommand(body: Interaction): boolean {
  return (
    body.type === APPLICATION_COMMAND && body.data?.name === SHARE_COMMAND
  );
}

// The "/unsubscribe" slash command — silences the daily recap in this channel (a DB write).
function isUnsubscribeCommand(body: Interaction): boolean {
  return (
    body.type === APPLICATION_COMMAND && body.data?.name === UNSUBSCRIBE_COMMAND
  );
}

// Pure routing of a verified interaction to its inline response body. Kept separate from
// the HTTP layer so it can be unit-tested without a request. Launch commands and the Play
// button both open the Activity; the card is posted (via /api/post-card) afterward (see handler).
export function routeInteraction(body: Interaction): object {
  if (body.type === PING) return { type: PONG };
  if (isLaunchCommand(body)) return { type: LAUNCH_ACTIVITY };
  // The card/recap "Play now!" button launches the Activity.
  if (
    body.type === MESSAGE_COMPONENT &&
    body.data?.custom_id === PLAY_CUSTOM_ID
  ) {
    return { type: LAUNCH_ACTIVITY };
  }
  // "/enable-posts": help the user add the bot so recaps + the live card can post in this server.
  if (
    body.type === APPLICATION_COMMAND &&
    body.data?.name === ENABLE_POSTS_COMMAND
  ) {
    const appId = body.application_id ?? process.env.VITE_DISCORD_CLIENT_ID ?? "";
    // The command is registered GUILD-only (no DM context — see scripts/register-commands.mjs),
    // so it always runs in a server; no DM-flavoured copy needed.
    // Positively guild-installed ("0" present) → the bot is already here. Otherwise (user-install
    // only, or unknown) show the button — so we never wrongly tell a bot-less server it's all set.
    const owners = body.authorizing_integration_owners;
    if (owners && "0" in owners) {
      return {
        type: CHANNEL_MESSAGE_WITH_SOURCE,
        data: enablePostsAlreadyEnabled(),
      };
    }
    return { type: CHANNEL_MESSAGE_WITH_SOURCE, data: enablePostsAddBot(appId) };
  }
  // "/donate": a private reply with the Ko-fi link button (the footer's "Help cover the
  // server costs" link). Ephemeral — it's a personal nudge, not a channel post.
  if (
    body.type === APPLICATION_COMMAND &&
    body.data?.name === DONATE_COMMAND
  ) {
    return { type: CHANNEL_MESSAGE_WITH_SOURCE, data: donateMessage() };
  }
  return {
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: COPY.unsupported, flags: EPHEMERAL },
  };
}

// Fields we read off the launch interaction beyond the routing ones above.
type DiscordUserLite = {
  id?: string;
  username?: string;
  global_name?: string | null;
  avatar?: string | null;
};
type LaunchInteraction = Interaction & {
  application_id?: string;
  token?: string;
  guild_id?: string;
  channel_id?: string;
  channel?: { id?: string };
  member?: { user?: DiscordUserLite };
  user?: DiscordUserLite;
  message?: { id?: string };
  authorizing_integration_owners?: Record<string, string>;
  app_permissions?: string;
};

// Build the /share interaction response from the player's own stored guesses. A public message
// (CHANNEL_MESSAGE_WITH_SOURCE, no EPHEMERAL flag) on success — Discord posts it on the app's
// behalf, so it works even where the bot isn't installed (user-install share). Anything that
// isn't a finished game returns an ephemeral nudge only the invoker sees, so a half-played or
// not-yet-played /share never spams the channel. Identity comes from the (Discord-verified)
// interaction, so there's no OAuth round-trip; the grid is replayed from the same append-only
// `progress` record /api/score trusts, so it can't be faked from the request.
async function shareResponse(body: LaunchInteraction): Promise<object> {
  const ephemeral = (content: string) => ({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: EPHEMERAL },
  });

  const u = body.member?.user ?? body.user;
  if (!u?.id) return ephemeral(COPY["share.no-account"]);

  // Heavy deps loaded here, off the launch-ACK cold path (see the import note up top).
  const { admin } = await import("./_admin.js");
  const { fetchPuzzle, todayET } = await import("./_nyt.js");
  const db = admin();
  if (!db) return ephemeral(COPY["share.unavailable"]);

  const date = todayET();
  const { data: progress } = await db
    .from("progress")
    .select("guesses")
    .eq("user_id", u.id)
    .eq("puzzle_date", date)
    .maybeSingle();
  const committed: unknown = progress?.guesses;
  if (!Array.isArray(committed) || committed.length === 0) {
    return ephemeral(COPY["share.not-played"]);
  }

  let puzzle: Puzzle;
  try {
    puzzle = await fetchPuzzle(date);
  } catch {
    return ephemeral(COPY["share.load-failed"]);
  }
  const game = Game.fromGuesses(puzzle, committed);
  if (game.status === "playing") {
    const left = game.mistakesLeft;
    return ephemeral(
      fill(COPY["share.mid-puzzle"], {
        solved: game.groupsSolved,
        mistakes: `${left} mistake${left === 1 ? "" : "s"}`,
      }),
    );
  }

  // Best-effort time + points from the player's scored row for today. The scores table keeps ONE
  // row per (puzzle, user) — pinned to the scope where they FIRST finished — so we look it up by
  // user + date only, NOT by the room /share runs in: those can differ, and filtering by scope
  // would miss the row (the bug where time/points silently dropped). Absent (never scored) → the
  // line just omits time/points; the grid still posts. Never blocks the share.
  let durationMs: number | null = null;
  let score: number | null = null;
  const { data: row } = await db
    .from("scores")
    .select("score, duration_ms")
    .eq("user_id", u.id)
    .eq("puzzle_date", date)
    .maybeSingle();
  if (row) {
    score = typeof row.score === "number" ? row.score : null;
    durationMs = typeof row.duration_ms === "number" ? row.duration_ms : null;
  }

  return {
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: IS_COMPONENTS_V2,
      components: shareCard(game, { puzzleNo: puzzle.id, durationMs, score }),
    },
  };
}

// Handle /unsubscribe: record a recap opt-out for the channel it was run in, so the daily cron
// skips it (recap_channels subtracts recap_optouts). Re-arms on the next launch here — post-card
// clears the row when it (re)establishes the card. Guild channels only: recaps don't post in DMs
// or user-install surfaces, so there's nothing to silence there. The Manage-Channels gate is
// enforced by Discord (default_member_permissions on the command), so this just does the write.
async function unsubscribeResponse(body: LaunchInteraction): Promise<object> {
  const guildId = typeof body.guild_id === "string" ? body.guild_id : null;
  const channelId =
    typeof body.channel_id === "string"
      ? body.channel_id
      : typeof body.channel?.id === "string"
        ? body.channel.id
        : null;
  const scope = canonicalScope(guildId, channelId);
  if (!scope || !scope.startsWith("g:") || !channelId) {
    return unsubscribeResult("no-guild");
  }

  const { admin } = await import("./_admin.js");
  const db = admin();
  if (!db) return unsubscribeResult("error");

  const u = body.member?.user ?? body.user;
  // Plain insert (not upsert): a unique violation (23505) means this channel was ALREADY opted
  // out and hasn't been re-armed by a launch since — so report "already off" rather than re-post
  // the public confirmation. A launch in the meantime deletes the row (post-card), so a genuine
  // re-subscribe-then-unsubscribe inserts cleanly and reads "done" again.
  const { error } = await db.from("recap_optouts").insert({
    scope_id: scope,
    channel_id: channelId,
    opted_out_by: u?.id ?? null,
    opted_out_at: new Date().toISOString(),
  });
  if (error) {
    if (error.code === "23505") {
      console.log("[unsubscribe] already opted out", { scope, channel: channelId });
      return unsubscribeResult("already");
    }
    console.error(
      "[unsubscribe] insert error (schema migrated?)",
      error.message,
    );
    return unsubscribeResult("error");
  }
  console.log("[unsubscribe] opted out", { scope, channel: channelId, by: u?.id });
  return unsubscribeResult("done");
}

// Where /api/post-card lives so we can self-call it (shared base resolver — see api/_internal.ts).
function postCardBase(): string {
  return internalBase();
}

// Fire the "who's playing" render at /api/post-card (a separate function that carries the heavy
// canvas addon), so THIS function's deployment stays tiny and its cold launch ACK lands inside
// Discord's 3s window. Forwards the verified raw interaction (token included, so DM cards still
// post) and authenticates with INTERNAL_SECRET. Best-effort — a failed trigger just means no card,
// never a blocked launch.
async function triggerPostCard(raw: string): Promise<void> {
  const base = postCardBase();
  const secret = process.env.INTERNAL_SECRET ?? "";
  if (!base || !secret) {
    console.warn("[card] skip trigger: missing post-card base URL or INTERNAL_SECRET");
    return;
  }
  const r = await fetch(`${base}/api/post-card`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: raw,
  });
  if (!r.ok) console.error("[card] post-card trigger failed", { status: r.status });
}

async function rawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(
      typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer),
    );
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  // The keep-warm cron pings GET; answer 200 so the lambda stays warm without 405 log noise.
  if (req.method === "GET") {
    res.status(200).json({ ok: true });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const raw = await rawBody(req);
  const sig = req.headers["x-signature-ed25519"];
  const ts = req.headers["x-signature-timestamp"];
  if (
    !verifyDiscordSig(
      raw,
      String(sig ?? ""),
      String(ts ?? ""),
      process.env.DISCORD_PUBLIC_KEY ?? "",
    )
  ) {
    res.status(401).json({ error: "invalid request signature" });
    return;
  }
  let body: LaunchInteraction;
  try {
    body = JSON.parse(raw) as LaunchInteraction;
  } catch {
    res.status(400).json({ error: "bad body" });
    return;
  }

  // "/unsubscribe" writes a recap opt-out (a DB write), so like /share it's handled off the pure
  // router. One indexed upsert, comfortably inside the 3s deadline; a throw degrades to an
  // ephemeral apology rather than a dead "did not respond".
  if (isUnsubscribeCommand(body)) {
    let response: object;
    try {
      response = await unsubscribeResponse(body);
    } catch (e) {
      console.error("[unsubscribe] threw", e instanceof Error ? e.message : e);
      response = unsubscribeResult("error");
    }
    res.status(200).json(response);
    return;
  }

  // "/share" needs the player's stored guesses (a DB read), so it can't go through the pure
  // synchronous router. Build its response (the result grid, or an ephemeral nudge) and reply
  // — comfortably inside the 3s deadline: one indexed `progress` read + a cached puzzle fetch.
  // A thrown error degrades to an ephemeral apology rather than a dead "did not respond".
  if (isShareCommand(body)) {
    let response: object;
    try {
      response = await shareResponse(body);
    } catch (e) {
      console.error("[share] threw", e instanceof Error ? e.message : e);
      response = {
        type: CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: COPY["share.build-failed"], flags: EPHEMERAL },
      };
    }
    res.status(200).json(response);
    return;
  }

  const launch = isLaunchCommand(body) || isPlayButton(body);

  // Log the launch ACK timing BEFORE the response is flushed. This MUST run pre-response:
  // Vercel does NOT reliably drain stdout written after res.json() (the function suspends once the
  // response is sent), which is why the previous post-response slow-ACK probe never appeared —
  // its silence meant "never logged", NOT "ACK was fast". So we had no lagMs data at all. Logging
  // here (the same pre-response phase whose logs DO survive) finally surfaces it. Cost is one
  // Date.now() subtraction + one console.log — sub-millisecond, nowhere near Discord's 3s budget,
  // so the ACK still lands in time even on a cold start. `x-signature-timestamp` is (to the second)
  // when Discord sent the request, so now − ts ≈ inbound launch latency (cold start + queue +
  // network); it's whole-seconds so it OVER-estimates by up to ~1s (never hides a slow ACK). This
  // only sees INBOUND latency — a launch dropped for a non-latency reason, or one where Discord
  // never opens the iframe (a stuck/zombie per-channel instance), still logs a fast ack here and is
  // distinguished by whether /api/launch-beacon's "boot" stage ever fires.
  if (launch) {
    const tsSec = Number(typeof ts === "string" ? ts : 0);
    const lagMs = tsSec ? Date.now() - tsSec * 1000 : 0;
    const surface = body.type === MESSAGE_COMPONENT ? "button" : "command";
    // Stamp the ack with the channel/guild it launched in. This is the correlation key for
    // detecting a FAILED launch: a "[launch] ack" whose channel never gets a following
    // "[launch] beacon stage=boot" (the inline index.html script stamps the beacon with the same
    // channel_id from the iframe URL) is a launch Discord acked but never opened. channel_id is the
    // only id shared by both sides — the iframe instance_id doesn't exist yet at ack time. guild is
    // null in a DM, so channel alone keys a DM launch.
    const channel =
      typeof body.channel_id === "string"
        ? body.channel_id
        : typeof body.channel?.id === "string"
          ? body.channel.id
          : null;
    const guild = typeof body.guild_id === "string" ? body.guild_id : null;
    console.log("[launch] ack", { lagMs, surface, channel, guild });
    if (lagMs >= 2000)
      console.error("[launch] slow ACK — at risk of missing Discord's 3s deadline", {
        lagMs,
        surface,
        channel,
      });
  }

  // ACK (Discord enforces a 3s deadline) — this is the LAUNCH_ACTIVITY that opens the game.
  res.status(200).json(routeInteraction(body));

  if (launch) {
    // Then trigger the card render in /api/post-card (a separate, heavier function). waitUntil
    // keeps this function alive past the response flush; the trigger is fire-and-forget — the
    // launch is already ACKed, so a slow or failed render never blocks the game opening.
    waitUntil(
      triggerPostCard(raw).catch((e) => {
        console.error("[card] trigger failed", e instanceof Error ? e.message : e);
      }),
    );
  }
}
