import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createPublicKey, verify as edVerify } from "node:crypto";
import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  disablePostsResult,
  donateMessage,
  enablePostsAddBot,
  enablePostsAlreadyEnabled,
  enablePostsNeedPerms,
  enablePostsReenabled,
  EPHEMERAL,
  installNudgePayload,
  IS_COMPONENTS_V2,
  missingPermsNudgePayload,
  shareCard,
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
// this function triggers (fire-and-forget) AFTER the ACK. /share, /enable-posts, and /disable-posts
// still answer here synchronously and lazy-import the Supabase SDK (_admin/_nyt) so the launch ACK
// never pays for it.

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
// The "/disable-posts" command: a moderator turns the bot's posts off in the channel it's run in —
// BOTH the live "who's playing" card AND the nightly recap. It writes a post_optouts row that
// post-card checks (skips posting) and recap_channels() subtracts (skips the cron). Sticky: playing
// or solving here does NOT turn posts back on — only /enable-posts in this channel does. Registered
// guild-install only + Manage Channels gated (scripts/register-commands.mjs), so it only appears
// where the bot can post and only for members who can configure the channel.
const DISABLE_POSTS_COMMAND = "disable-posts";
// The pre-rename name. Global command renames propagate to clients over ~an hour, so a cached
// command list can still fire "/unsubscribe" mid-rollout — keep accepting it as an alias.
const DISABLE_POSTS_ALIAS = "unsubscribe";

// The message payload builders + their flags/constants live in src/discord-messages.ts
// (node-free, shared with the preview harness). Re-exported below so existing importers
// (tests, callers) keep their import path.
export {
  disablePostsResult,
  installNudgePayload,
  missingPermsNudgePayload,
  shareCard,
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

// The "/disable-posts" slash command — turns the bot's posts off in this channel (a DB write).
// Accepts the old "/unsubscribe" name too, for clients still on a cached command list mid-rename.
function isDisablePostsCommand(body: Interaction): boolean {
  const name = body.data?.name;
  return (
    body.type === APPLICATION_COMMAND &&
    (name === DISABLE_POSTS_COMMAND || name === DISABLE_POSTS_ALIAS)
  );
}

// The "/enable-posts" slash command — where the bot isn't installed, a private "Add to Server"
// pitch; where it IS, it clears any /disable-posts opt-out for this channel (a DB write).
function isEnablePostsCommand(body: Interaction): boolean {
  return (
    body.type === APPLICATION_COMMAND &&
    body.data?.name === ENABLE_POSTS_COMMAND
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
  // "/enable-posts" is handled off the pure router (it may clear a /disable-posts opt-out, a DB
  // write) — see enablePostsResponse in the main handler.
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
  member?: { user?: DiscordUserLite; permissions?: string };
  user?: DiscordUserLite;
  message?: { id?: string };
  authorizing_integration_owners?: Record<string, string>;
  app_permissions?: string;
};

// Manage Channels (1<<4) — the moderator bar for re-enabling posts, the mirror of the Discord-side
// default_member_permissions gate on /disable-posts. Discord hands us the invoking member's computed
// channel permissions on the interaction (Administrator, 1<<3, implies all of them, so a single mask
// covers admins/owner too). Absent or malformed perms read as "not a mod" — fail closed.
const MANAGE_CHANNELS_MASK = (1n << 4n) | (1n << 3n);
export function memberCanManageChannels(permissions: string | undefined): boolean {
  if (!permissions) return false;
  try {
    return (BigInt(permissions) & MANAGE_CHANNELS_MASK) !== 0n;
  } catch {
    return false;
  }
}

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

// Handle /disable-posts: record a post opt-out for the channel it was run in, so the bot goes
// silent there — post-card skips the live card (it checks post_optouts) and the daily cron skips
// the recap (recap_channels subtracts post_optouts). Sticky: nothing re-arms it except
// /enable-posts in this channel. Guild channels only: the bot only posts in server channels, so
// there's nothing to silence in a DM/user-install surface. The Manage-Channels gate is enforced by
// Discord (default_member_permissions on the command), so this just does the write + card teardown.
async function disablePostsResponse(body: LaunchInteraction): Promise<object> {
  const guildId = typeof body.guild_id === "string" ? body.guild_id : null;
  const channelId =
    typeof body.channel_id === "string"
      ? body.channel_id
      : typeof body.channel?.id === "string"
        ? body.channel.id
        : null;
  const scope = canonicalScope(guildId, channelId);
  if (!scope || !scope.startsWith("g:") || !channelId) {
    return disablePostsResult("no-guild");
  }

  const { admin } = await import("./_admin.js");
  const db = admin();
  if (!db) return disablePostsResult("error");

  const u = body.member?.user ?? body.user;
  // Plain insert (not upsert): a unique violation (23505) means this channel was ALREADY off — it's
  // sticky, so nothing re-armed it — so report "already off" rather than re-post the public
  // confirmation. Either way we tear the card down below (idempotent), which also heals a channel
  // still carrying a pre-rename recap-only opt-out that never suppressed the live card.
  const { error } = await db.from("post_optouts").insert({
    scope_id: scope,
    channel_id: channelId,
    opted_out_by: u?.id ?? null,
    opted_out_at: new Date().toISOString(),
  });
  let kind: "done" | "already";
  if (error) {
    if (error.code === "23505") {
      console.log("[disable-posts] already off", { scope, channel: channelId });
      kind = "already";
    } else {
      console.error("[disable-posts] insert error (schema migrated?)", error.message);
      return disablePostsResult("error");
    }
  } else {
    console.log("[disable-posts] posts off", { scope, channel: channelId, by: u?.id });
    kind = "done";
  }

  // Silence the live card now, so disabling is immediate rather than "starting tomorrow": null
  // today's card message_id (every edit path — refresh-card/join/finalize — bails without one) and
  // best-effort delete the posted message (the bot deleting its own message needs no extra perms).
  // Best-effort throughout — the null is the load-bearing guarantee; a failed delete just leaves the
  // frozen card until it ages out.
  try {
    const { todayET } = await import("./_nyt.js");
    const date = todayET();
    const { data: liveRow } = await db
      .from("live_cards")
      .select("message_id")
      .eq("scope_id", scope)
      .eq("puzzle_date", date)
      .eq("channel_id", channelId)
      .maybeSingle();
    await db
      .from("live_cards")
      .update({ message_id: null })
      .eq("scope_id", scope)
      .eq("puzzle_date", date)
      .eq("channel_id", channelId);
    const messageId = (liveRow?.message_id as string | null | undefined) ?? null;
    const botToken = process.env.DISCORD_BOT_TOKEN ?? "";
    if (messageId && botToken) {
      const r = await fetch(
        `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
        { method: "DELETE", headers: { Authorization: `Bot ${botToken}` } },
      );
      if (!r.ok && r.status !== 404)
        console.warn("[disable-posts] card delete failed", { status: r.status });
    }
  } catch (e) {
    console.warn("[disable-posts] card teardown failed", e instanceof Error ? e.message : e);
  }

  return disablePostsResult(kind);
}

// Handle /enable-posts. Where the bot ISN'T guild-installed, the private "Add to Server" pitch (the
// only way posts can happen there at all). Where it IS, clear any /disable-posts opt-out for this
// channel so the live card + recap post again. Publicly confirms a real re-enable; stays ephemeral
// when there was nothing to turn on. Re-enabling is a moderation action (the mirror of
// /disable-posts), so it carries the same Manage-Channels gate, enforced by Discord.
export async function enablePostsResponse(body: LaunchInteraction): Promise<object> {
  const appId = body.application_id ?? process.env.VITE_DISCORD_CLIENT_ID ?? "";
  // Positively guild-installed ("0" present) → the bot is already here. Otherwise (user-install
  // only, or unknown) show the button — so we never wrongly tell a bot-less server it's all set.
  const owners = body.authorizing_integration_owners;
  if (!(owners && "0" in owners)) {
    return { type: CHANNEL_MESSAGE_WITH_SOURCE, data: enablePostsAddBot(appId) };
  }

  const guildId = typeof body.guild_id === "string" ? body.guild_id : null;
  const channelId =
    typeof body.channel_id === "string"
      ? body.channel_id
      : typeof body.channel?.id === "string"
        ? body.channel.id
        : null;
  const scope = canonicalScope(guildId, channelId);
  // Installed but no usable channel context (shouldn't happen for a guild command) — just reassure.
  if (!scope || !scope.startsWith("g:") || !channelId) {
    return { type: CHANNEL_MESSAGE_WITH_SOURCE, data: enablePostsAlreadyEnabled() };
  }

  const { admin } = await import("./_admin.js");
  const db = admin();
  if (!db) return { type: CHANNEL_MESSAGE_WITH_SOURCE, data: enablePostsAlreadyEnabled() };

  // Re-enabling (clearing a /disable-posts opt-out) is a moderation action — the mirror of
  // /disable-posts — so it needs Manage Channels. The command itself is left open (no Discord gate)
  // so anyone can still reach the add-bot pitch above in a bot-less server; only this clear-branch is
  // gated, in code. A non-mod who runs it where posts are actually off is told a mod is needed; where
  // nothing's off, just reassured they're on (no privileged action, so no need to gate that).
  if (!memberCanManageChannels(body.member?.permissions)) {
    const { data: existing } = await db
      .from("post_optouts")
      .select("scope_id")
      .eq("scope_id", scope)
      .eq("channel_id", channelId)
      .maybeSingle();
    console.log("[enable-posts] non-mod", { scope, channel: channelId, disabled: !!existing });
    return {
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: existing ? enablePostsNeedPerms() : enablePostsAlreadyEnabled(),
    };
  }

  // Delete + returning: a returned row means a /disable-posts opt-out was actually cleared (→ public
  // "back on"); an empty result means posts were already on (→ ephemeral, no state changed).
  const { data: cleared, error } = await db
    .from("post_optouts")
    .delete()
    .eq("scope_id", scope)
    .eq("channel_id", channelId)
    .select("scope_id");
  if (error) {
    console.error("[enable-posts] clear opt-out error", error.message);
    // Couldn't tell — reassure rather than claim a re-enable that may not have happened.
    return { type: CHANNEL_MESSAGE_WITH_SOURCE, data: enablePostsAlreadyEnabled() };
  }
  const reenabled = Array.isArray(cleared) && cleared.length > 0;
  console.log(reenabled ? "[enable-posts] re-enabled" : "[enable-posts] already on", {
    scope,
    channel: channelId,
  });
  return {
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: reenabled ? enablePostsReenabled() : enablePostsAlreadyEnabled(),
  };
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

  // "/disable-posts" and "/enable-posts" write to the DB (a post opt-out, and clearing it), so like
  // /share they're handled off the pure router. Each is a couple of indexed writes, comfortably
  // inside the 3s deadline; a throw degrades to an ephemeral apology rather than a dead "did not
  // respond".
  if (isDisablePostsCommand(body)) {
    let response: object;
    try {
      response = await disablePostsResponse(body);
    } catch (e) {
      console.error("[disable-posts] threw", e instanceof Error ? e.message : e);
      response = disablePostsResult("error");
    }
    res.status(200).json(response);
    return;
  }
  if (isEnablePostsCommand(body)) {
    let response: object;
    try {
      response = await enablePostsResponse(body);
    } catch (e) {
      console.error("[enable-posts] threw", e instanceof Error ? e.message : e);
      response = { type: CHANNEL_MESSAGE_WITH_SOURCE, data: enablePostsAlreadyEnabled() };
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
