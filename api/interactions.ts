import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createPublicKey, verify as edVerify } from "node:crypto";
import {
  CHANNEL_MESSAGE_WITH_SOURCE,
  disablePostsResult,
  donateMessage,
  enablePostsAlreadyEnabled,
  enablePostsNeedPerms,
  enablePostsReenabled,
  EPHEMERAL,
  helpMessage,
  inviteBotMessage,
  IS_COMPONENTS_V2,
  missingPermsNudgePayload,
  shareCard,
  unmuteBotless,
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
// this function triggers (fire-and-forget) AFTER the ACK. /share, /unmute, and /mute
// still answer here synchronously and lazy-import the Supabase SDK (_admin/_puzzles) so the launch ACK
// never pays for it.

// Discord interactions webhook. Discord POSTs here for: the typed /disconnections (or
// /connections alias) command, the App-Launcher Entry Point command, the card/recap
// "Play now!" button, and a PING.
//
// A launch command is answered with LAUNCH_ACTIVITY (the game auto-opens) — we send that ACK
// ourselves (APP_HANDLER), so Discord never posts its own Game Invitation card; only our custom
// card appears, rendered by /api/post-card. (A LAUNCH_ACTIVITY response leaves a "<user> used
// /disconnections" line, so the followup card lands just under it.)
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
// and the primary chat-input command arrive as APPLICATION_COMMAND interactions named
// `disconnections`. `connections` is registered too, as an indefinite post-rebrand alias
// (scripts/register-commands.mjs) — same launch behavior, described as "Launch
// Disconnections". `play` is kept as a further alias in case either name collides with the
// Entry Point command name at registration time. Keep this set in sync with the names
// registered in scripts/register-commands.mjs (its header comment demands it): missing a
// name here means that command launches nothing.
const LAUNCH_COMMANDS = new Set(["disconnections", "connections", "play"]);

// The "/unmute" command: turns Disconnections' posts back on in this channel by clearing the
// /mute opt-out. Works in bot-less servers too — posts happen there now (the token-backed
// who's playing card plus the piggybacked recap), so the reply confirms that and offers the bot
// as the upgrade instead of pitching an install. RENAMED from /enable-posts; the old name stays
// accepted below while the rename propagates to clients (~an hour for a global command).
const UNMUTE_COMMAND = "unmute";
const UNMUTE_ALIAS = "enable-posts";
// The "/invite-bot" command: the "Add to Server" link, privately. This is where the install pitch
// lives now that the mid-launch popup is gone.
const INVITE_BOT_COMMAND = "invite-bot";
// The "/help" command: a private, static list of what the app's commands do.
const HELP_COMMAND = "help";
// The "/share" command (mirrors Wordle's share): posts the player's finished result grid —
// one row of category-colour squares per guess — publicly to the channel. Computed from the
// player's stored guesses (a DB read), so it's handled off the pure router (see shareResponse).
const SHARE_COMMAND = "share";
// The "/donate" command: replies (privately) with a Ko-fi link button — the same one in the
// app footer. Disconnections is free and ad-free; donations cover the server costs. KEEP the
// URL in sync with the Ko-fi link in src/infolinks.tsx.
const DONATE_COMMAND = "donate";
// The "/mute" command: a moderator turns Disconnections' posts off in the channel it's run in —
// the "who's playing" card (bot-posted or token-backed), the piggybacked recap, and the nightly bot
// recap alike. It writes a post_optouts row that post-card checks on BOTH post paths (skips posting)
// and recap_channels() subtracts (skips the cron). Sticky: playing or solving here does NOT turn
// posts back on — only /unmute in this channel does. Manage Channels gated
// (scripts/command-defs.mjs) so a random member can't silence a channel others want.
const MUTE_COMMAND = "mute";
// Pre-rename names. Global command renames propagate to clients over ~an hour, so a cached command
// list can still fire the old name mid-rollout — keep accepting them as aliases.
// ("/unsubscribe" was the name before "/disable-posts"; both map here.)
const MUTE_ALIASES = ["disable-posts", "unsubscribe"];

// The message payload builders + their flags/constants live in src/discord-messages.ts
// (node-free, shared with the preview harness). Re-exported below so existing importers
// (tests, callers) keep their import path.
export {
  disablePostsResult,
  helpMessage,
  inviteBotMessage,
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

// The "/mute" slash command — turns Disconnections' posts off in this channel (a DB write).
// Accepts the pre-rename names too, for clients still on a cached command list mid-rename.
function isDisablePostsCommand(body: Interaction): boolean {
  const name = body.data?.name ?? "";
  return (
    body.type === APPLICATION_COMMAND &&
    (name === MUTE_COMMAND || MUTE_ALIASES.includes(name))
  );
}

// The "/unmute" slash command — clears this channel's /mute opt-out (a DB write). Accepts the
// pre-rename "/enable-posts" name too.
function isEnablePostsCommand(body: Interaction): boolean {
  const name = body.data?.name ?? "";
  return (
    body.type === APPLICATION_COMMAND &&
    (name === UNMUTE_COMMAND || name === UNMUTE_ALIAS)
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
  // "/unmute" is handled off the pure router (it may clear a /mute opt-out, a DB write) — see
  // enablePostsResponse in the main handler.
  // "/donate": a private reply with the Ko-fi link button (the footer's "Help cover the
  // server costs" link). Ephemeral — it's a personal nudge, not a channel post.
  if (
    body.type === APPLICATION_COMMAND &&
    body.data?.name === DONATE_COMMAND
  ) {
    return { type: CHANNEL_MESSAGE_WITH_SOURCE, data: donateMessage() };
  }
  // "/invite-bot": the private "Add to Server" link. Static, so it answers right here — this is
  // the install path now that the mid-launch popup is gone (the piggybacked recap's aside is the
  // other). appId comes off the interaction, with the env as a fallback.
  if (
    body.type === APPLICATION_COMMAND &&
    body.data?.name === INVITE_BOT_COMMAND
  ) {
    const appId = body.application_id ?? process.env.VITE_DISCORD_CLIENT_ID ?? "";
    return { type: CHANNEL_MESSAGE_WITH_SOURCE, data: inviteBotMessage(appId) };
  }
  // "/help": the private command list. Static copy (src/discord-copy.md → help).
  if (body.type === APPLICATION_COMMAND && body.data?.name === HELP_COMMAND) {
    return { type: CHANNEL_MESSAGE_WITH_SOURCE, data: helpMessage() };
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

// Manage Channels (1<<4) — the moderator bar for un-muting a channel, the mirror of the Discord-side
// default_member_permissions gate both /mute and /unmute now carry. Discord hands us the invoking member's computed
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
  const { fetchPuzzle, todayET } = await import("./_puzzles.js");
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

// Handle /mute: record a post opt-out for the channel it was run in, so Disconnections goes silent
// there — post-card skips the live card on BOTH paths (bot-posted and token-backed) and skips the
// piggybacked recap, and the daily cron skips the bot recap (recap_channels subtracts
// post_optouts). Sticky: nothing re-arms it except /unmute in this channel. Guild channels only:
// a DM/group DM has no moderator surface to silence. The Manage-Channels gate is enforced by
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
  // Plain insert (not upsert): a unique violation (23505) means this channel was ALREADY muted —
  // it's sticky, so nothing re-armed it — so report "already off" rather than re-post the public
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
      console.log("[disable-posts] already muted", { scope, channel: channelId });
      kind = "already";
    } else {
      console.error("[disable-posts] insert error (schema migrated?)", error.message);
      return disablePostsResult("error");
    }
  } else {
    console.log("[disable-posts] posts off", { scope, channel: channelId, by: u?.id });
    kind = "done";
  }

  // Silence the live card now, so muting is immediate rather than "starting tomorrow": null
  // today's card message_id (every edit path — refresh-card/join/finalize — bails without one) and
  // best-effort delete the posted message (the bot deleting its own message needs no extra perms;
  // in a bot-less server there's no bot token to delete WITH, so the token card just freezes).
  // Best-effort throughout — the null is the load-bearing guarantee; a failed delete just leaves the
  // frozen card until it ages out.
  try {
    const { todayET } = await import("./_puzzles.js");
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

// Handle /unmute: clear this channel's /mute opt-out so Disconnections posts here again. It now runs
// the SAME path in every server, with or without the bot — because posts exist either way: with the
// bot it's the all-day live card + the midnight recap; without it, the token-backed card plus
// yesterday's recap piggybacked onto the day's first launch (api/post-card.ts). Only the wording
// differs: a bot-less room's reply adds the one-line invite offer instead of pretending nothing can
// post there. Publicly confirms a real un-mute; stays ephemeral when there was nothing to turn on.
// Un-muting is a moderation action (the mirror of /mute), so it carries the same Manage-Channels
// gate — now enforced by Discord too (default_member_permissions, see scripts/command-defs.mjs) and
// still checked here as defense in depth.
export async function enablePostsResponse(body: LaunchInteraction): Promise<object> {
  const appId = body.application_id ?? process.env.VITE_DISCORD_CLIENT_ID ?? "";
  // Positively guild-installed ("0" present) = the bot is here. Otherwise (user-install only, or
  // unknown) treat it as bot-less, so we never promise all-day edits a room can't get.
  const owners = body.authorizing_integration_owners;
  const botInstalled = !!(owners && "0" in owners);
  // The "nothing was muted" reply, in the flavour that matches this room.
  const alreadyOn = () =>
    botInstalled ? enablePostsAlreadyEnabled() : unmuteBotless(appId, false);

  const guildId = typeof body.guild_id === "string" ? body.guild_id : null;
  const channelId =
    typeof body.channel_id === "string"
      ? body.channel_id
      : typeof body.channel?.id === "string"
        ? body.channel.id
        : null;
  const scope = canonicalScope(guildId, channelId);
  // No usable channel context (shouldn't happen for a guild-only command) — just reassure.
  if (!scope || !scope.startsWith("g:") || !channelId) {
    return { type: CHANNEL_MESSAGE_WITH_SOURCE, data: alreadyOn() };
  }

  const { admin } = await import("./_admin.js");
  const db = admin();
  if (!db) return { type: CHANNEL_MESSAGE_WITH_SOURCE, data: alreadyOn() };

  // Clearing a /mute opt-out is a moderation action, so it needs Manage Channels. A non-mod who runs
  // it where posts are actually muted is told a mod is needed; where nothing's muted, just reassured
  // they're on (no privileged action, so no need to gate that).
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
      data: existing ? enablePostsNeedPerms() : alreadyOn(),
    };
  }

  // Delete + returning: a returned row means a /mute opt-out was actually cleared (→ public "back
  // on"); an empty result means posts were already on (→ ephemeral, no state changed).
  const { data: cleared, error } = await db
    .from("post_optouts")
    .delete()
    .eq("scope_id", scope)
    .eq("channel_id", channelId)
    .select("scope_id");
  if (error) {
    console.error("[enable-posts] clear opt-out error", error.message);
    // Couldn't tell — reassure rather than claim an un-mute that may not have happened.
    return { type: CHANNEL_MESSAGE_WITH_SOURCE, data: alreadyOn() };
  }
  const reenabled = Array.isArray(cleared) && cleared.length > 0;
  console.log(reenabled ? "[enable-posts] unmuted" : "[enable-posts] already on", {
    scope,
    channel: channelId,
    botInstalled,
  });
  const data = reenabled
    ? botInstalled
      ? enablePostsReenabled()
      : unmuteBotless(appId, true)
    : alreadyOn();
  return { type: CHANNEL_MESSAGE_WITH_SOURCE, data };
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

  // "/mute" and "/unmute" write to the DB (a post opt-out, and clearing it), so like
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
