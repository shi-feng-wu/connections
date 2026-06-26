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
import { Game, type Puzzle } from "../src/game.js";
import { canonicalScope } from "../src/scope.js";
import { admin } from "./_admin.js";
import type { CardPlayer } from "./_card.js";
import {
  botCardUrl,
  CARD_POST_COOLDOWN_MS,
  cardPayload,
  interactionFollowupUrl,
  playerFinished,
  sendCard,
  withGrids,
} from "./_livecard.js";
import { fetchPuzzle, todayET } from "./_nyt.js";
import { PLAY_CUSTOM_ID } from "./_recap.js";

// Discord interactions webhook. Discord POSTs here for: the typed /connections command,
// the App-Launcher Entry Point command, the card/recap "Play now!" button, and a PING.
//
// A launch command is answered with LAUNCH_ACTIVITY (the game auto-opens), then we post
// the "who's playing" card as an interaction FOLLOWUP — an interaction-bound message (like
// the Wordle card) that needs no bot to create. The app owns it, so /api/join and
// /api/refresh-card edit it via the bot token (no 15-minute limit) to keep it live all
// day. The card's "Play now!" button launches too. (A LAUNCH_ACTIVITY response also leaves
// a "<user> used /connections" line, so the followup card lands just under it.)
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
// channel — until someone launches the Activity here again, which clears the row (see postCard).
// Registered guild-install only + Manage Channels gated (scripts/register-commands.mjs), so it
// only appears where the bot can post recaps and only for members who can configure the channel.
const UNSUBSCRIBE_COMMAND = "unsubscribe";

// The message payload builders + their flags/constants now live in src/discord-messages.ts
// (node-free, shared with the preview harness): installUrl, the /enable-posts + /donate +
// /unsubscribe replies, the install/permission nudges, and the /share card. Re-exported below
// so existing importers (tests, callers) keep their import path.
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
// button both open the Activity; the card is posted as a followup afterward (see handler).
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
    data: { content: "Unsupported interaction.", flags: EPHEMERAL },
  };
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
  if (!u?.id) return ephemeral("Couldn’t read your Discord account — try again.");

  const db = admin();
  if (!db) return ephemeral("Sharing is unavailable right now — try again in a bit.");

  const date = todayET();
  const { data: progress } = await db
    .from("progress")
    .select("guesses")
    .eq("user_id", u.id)
    .eq("puzzle_date", date)
    .maybeSingle();
  const committed: unknown = progress?.guesses;
  if (!Array.isArray(committed) || committed.length === 0) {
    return ephemeral(
      "You haven’t played today’s Connections yet. Launch it with `/connections`, then `/share` your grid.",
    );
  }

  let puzzle: Puzzle;
  try {
    puzzle = await fetchPuzzle(date);
  } catch {
    return ephemeral("Couldn’t load today’s puzzle just now — try `/share` again in a moment.");
  }
  const game = Game.fromGuesses(puzzle, committed);
  if (game.status === "playing") {
    const left = game.mistakesLeft;
    return ephemeral(
      `You’re still mid-puzzle — ${game.groupsSolved}/4 groups, ${left} mistake${left === 1 ? "" : "s"} left. ` +
        "Finish it, then `/share` your grid.",
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
// skips it (recap_channels subtracts recap_optouts). Re-arms on the next launch here — postCard
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

  const db = admin();
  if (!db) return unsubscribeResult("error");

  const u = body.member?.user ?? body.user;
  // Plain insert (not upsert): a unique violation (23505) means this channel was ALREADY opted
  // out and hasn't been re-armed by a launch since — so report "already off" rather than re-post
  // the public confirmation. A launch in the meantime deletes the row (postCard), so a genuine
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

// Ephemeral "add the bot" nudge (installNudgePayload) for a launch in a server without the
// bot — the highest-intent install moment there is (someone is actively playing where recaps
// can't post). Re-shown to the same player in the same room at most once per cooldown.
const INSTALL_NUDGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// Whether this interaction was authorized ONLY as a user install — the app is on the user's
// account, not installed to this guild, so the bot isn't a member and can't post/edit the
// card (it would 403 with Missing Access). authorizing_integration_owners keys the install
// types that authorized the interaction: "0" = GUILD_INSTALL (the bot is in this guild),
// "1" = USER_INSTALL. We skip the card only when it's positively user-install ("1") and not
// guild-install ("0") — an absent or unexpected field proceeds (old behaviour), so a real
// guild card is never suppressed. Scoring/leaderboard are unaffected (they don't need the bot).
export function isUserInstallOnly(body: {
  authorizing_integration_owners?: Record<string, string>;
}): boolean {
  const owners = body.authorizing_integration_owners;
  if (!owners || typeof owners !== "object") return false;
  return "1" in owners && !("0" in owners);
}

// Discord permission bits the card/recap need in a channel (compared as BigInt — the bitfield
// exceeds 2^53). Both the live "who's playing" card and the nightly recap are PNG attachments,
// so Attach Files is required alongside View Channel + Send Messages.
const PERM_ADMINISTRATOR = 1n << 3n;
const PERM_VIEW_CHANNEL = 1n << 10n;
const PERM_SEND_MESSAGES = 1n << 11n;
const PERM_ATTACH_FILES = 1n << 15n;

// Whether the bot can post the card/recap in the channel an interaction came from, read straight
// from Discord's app_permissions (the bot's already-computed effective permissions there — no API
// call). This is what separates "bot is in the server but can't post in THIS channel" — typically
// a private channel the bot's role was never added to, where the nightly recap then silently 403s
// — from a healthy channel. Administrator implies everything. An absent or unparseable field fails
// OPEN (returns true), so we never wrongly nudge where the bot can in fact post, matching
// postCard's "proceed when unsure" posture elsewhere. Exported for tests.
export function botCanPostInChannel(appPermissions?: string): boolean {
  if (!appPermissions) return true;
  let bits: bigint;
  try {
    bits = BigInt(appPermissions);
  } catch {
    return true;
  }
  if (bits & PERM_ADMINISTRATOR) return true;
  const need = PERM_VIEW_CHANNEL | PERM_SEND_MESSAGES | PERM_ATTACH_FILES;
  return (bits & need) === need;
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
  // For the Play button (a component interaction), the message the button was on.
  message?: { id?: string };
  // Which install types authorized this interaction: "0" = guild install, "1" = user install.
  authorizing_integration_owners?: Record<string, string>;
  // The bot's already-computed effective permissions in the channel this interaction came from,
  // as a decimal bitfield string. Discord hands this to us, so we can tell a channel the bot
  // can't post in (a private channel its role isn't allowed into) without an extra API call.
  app_permissions?: string;
};

// Post or refresh the room's "who's playing" card. At most one card per room every ~2h
// (CARD_POST_COOLDOWN_MS): the launch that opens a window creates it — a /connections
// command as an interaction followup (no bot), the "Play now!" button as a bot reply to
// the clicked card — and launches within the window edit that same message in place
// (needs the bot token) instead of posting a new card. /api/join + /api/refresh-card keep
// it live too. Runs after the launch ACK is already sent, so a failure never blocks play.
async function postCard(body: LaunchInteraction): Promise<void> {
  const appId = body.application_id ?? process.env.VITE_DISCORD_CLIENT_ID ?? "";
  const token = body.token ?? "";
  if (!appId || !token) {
    console.warn("[card] skip: no appId/token", {
      hasAppId: !!appId,
      hasToken: !!token,
    });
    return;
  }

  // The card is a room board, so only guild channels get one (mirrors /api/join's gate).
  const guildId = typeof body.guild_id === "string" ? body.guild_id : null;
  const channelId =
    typeof body.channel_id === "string"
      ? body.channel_id
      : typeof body.channel?.id === "string"
        ? body.channel.id
        : null;
  const scope = canonicalScope(guildId, channelId);
  if (!scope || !scope.startsWith("g:") || !channelId) {
    console.warn("[card] skip: no guild scope/channel", {
      guildId,
      channelId,
      scope,
    });
    return;
  }

  // A user-install launch in a server without the bot still has a guild_id (so the scope
  // gate above passes), but the bot can't post/edit there — it isn't a member. Skip the card
  // (the game, scoring, and the in-app leaderboard/roster all work without it) rather than
  // 403'ing on every edit — and instead show the launcher the ephemeral install nudge,
  // since this is exactly the room the recap/card pitch is for.
  if (isUserInstallOnly(body)) {
    console.log("[card] skip: user-install launch (bot not in this guild)", {
      guildId,
    });
    await nudgeInstall(body, scope, appId, token);
    return;
  }

  // Guild-installed, but maybe not allowed to post in THIS channel — typically a private channel
  // the bot's role was never added to. Discord hands us the bot's channel permissions on the
  // interaction, so we check with no extra call: if the bot can't post the card/recap here,
  // privately nudge the launcher to grant access. We DON'T return — a command launch's followup
  // card rides the interaction token and can still post (so the live card may appear); it's the
  // bot's own recap and in-window edits that 403, and this nudge is what gets those unblocked.
  if (!botCanPostInChannel(body.app_permissions)) {
    console.log("[card] bot lacks post permission in channel; nudging", {
      scope,
      channel: channelId,
    });
    await nudgeOnce(body, scope, appId, token, missingPermsNudgePayload(), "perms");
  }

  // Identity comes from the (Discord-verified) interaction, so no OAuth round-trip.
  const u = body.member?.user ?? body.user;
  if (!u?.id) {
    console.warn("[card] skip: no user on interaction");
    return;
  }
  const player: CardPlayer = {
    id: u.id,
    name: u.global_name ?? u.username ?? "Player",
    avatar: u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`
      : null,
  };

  const db = admin();
  if (!db) {
    console.warn("[card] skip: no db (admin client unconfigured)");
    return;
  }

  const date = todayET();
  const { data: card, error: selErr } = await db
    .from("live_cards")
    .select("players, message_id, channel_id, posted_at")
    .eq("scope_id", scope)
    .eq("puzzle_date", date)
    .eq("channel_id", channelId)
    .maybeSingle();
  if (selErr)
    console.error(
      "[card] live_cards select error (schema migrated?)",
      selErr.message,
    );

  // renderRoster/mergePlayer pull @napi-rs/canvas; load them lazily so PING and the Play
  // button (which never render) don't pay the native-addon cold start.
  const { mergePlayer, renderRoster } = await import("./_card.js");
  const existing: CardPlayer[] = Array.isArray(card?.players)
    ? (card.players as CardPlayer[])
    : [];

  const botToken = process.env.DISCORD_BOT_TOKEN ?? "";
  const cardChannel =
    (card?.channel_id as string | null | undefined) || channelId;
  const lastPost = card?.posted_at
    ? Date.parse(card.posted_at as string)
    : null;
  const withinCooldown =
    lastPost != null && Date.now() - lastPost < CARD_POST_COOLDOWN_MS;
  let messageId = (card?.message_id as string | null | undefined) ?? null;
  let channelForRow = cardChannel;
  let freshPost = false;

  // A fresh card (none yet, or the last one aged past the 2h cooldown) starts the roster
  // over with just this launcher; only an in-window edit merges onto the existing roster.
  // Without the reset the previous card's players carry forward and the roster accumulates
  // all day, so every new card reprints everyone who played earlier.
  const startingFresh = !messageId || !withinCooldown;
  const players = startingFresh
    ? [player]
    : mergePlayer(existing, player).players;

  let puzzle: Puzzle | null = null;
  try {
    puzzle = await fetchPuzzle(date);
  } catch {
    /* title falls back to no number; grids render blank */
  }

  // A player who already finished today's puzzle isn't playing anymore — don't add them
  // to the room card or post a new one on their click. (Puzzle null = couldn't fetch, so
  // we can't tell → fall through and treat them as still playing.)
  if (puzzle && (await playerFinished(db, puzzle, player.id, date))) {
    console.log("[card] skip: launcher already finished today", {
      scope,
      user: player.id,
    });
    return;
  }

  const renderPlayers = puzzle
    ? await withGrids(db, puzzle, date, players)
    : players;
  const png = await renderRoster(renderPlayers, {
    puzzleNo: puzzle?.id,
    puzzleDate: date,
  });

  // Cooldown — at most one card per room every CARD_POST_COOLDOWN_MS (2h). A launch within
  // that window edits the current card in place instead of posting another; editing needs
  // the bot token (the followup token can't edit a prior message). A deleted card (404)
  // falls through to a fresh post.
  if (messageId && withinCooldown && botToken) {
    const er = await sendCard(
      botCardUrl(cardChannel, messageId),
      cardPayload(),
      png,
      "PATCH",
      "card.png",
      { Authorization: `Bot ${botToken}` },
    );
    if (er.status === 404) messageId = null;
    else if (!er.ok)
      console.error(
        "[card] edit failed",
        { status: er.status },
        await er.text().catch(() => ""),
      );
  }

  // Post a fresh card when there's none yet, the last one is older than the cooldown, or it
  // was just found deleted. A button click posts it as a bot reply to the clicked message;
  // a command posts it as an interaction followup. `?wait=true` returns the new message id.
  if (!messageId || !withinCooldown) {
    const viaButton = body.type === MESSAGE_COMPONENT;
    let r: Response;
    if (viaButton) {
      const replyTo = body.message?.id
        ? { messageId: body.message.id, channelId }
        : undefined;
      r = await sendCard(
        botCardUrl(channelId),
        cardPayload(replyTo),
        png,
        "POST",
        "card.png",
        botToken ? { Authorization: `Bot ${botToken}` } : undefined,
      );
    } else {
      r = await sendCard(
        interactionFollowupUrl(appId, token),
        cardPayload(),
        png,
        "POST",
        "card.png",
      );
    }
    if (!r.ok) {
      console.error(
        "[card] post failed",
        { via: viaButton ? "button" : "command", status: r.status },
        await r.text().catch(() => ""),
      );
      return;
    }
    messageId = ((await r.json()) as { id?: string }).id ?? null;
    channelForRow = channelId;
    freshPost = true;
    console.log("[card] posted", {
      scope,
      via: viaButton ? "button" : "command",
      messageId,
      players: players.length,
    });
  }
  if (!messageId) return;

  const nowIso = new Date().toISOString();
  const { error: upErr } = await db.from("live_cards").upsert(
    {
      scope_id: scope,
      puzzle_date: date,
      players,
      message_id: messageId,
      channel_id: channelForRow,
      // Only a fresh post resets the 2h cooldown; in-window edits keep the original time.
      ...(freshPost ? { posted_at: nowIso } : {}),
      edited_at: nowIso, // anchors the live-edit throttle in /api/refresh-card
      updated_at: nowIso,
    },
    // Per-channel card: one row per (scope, day, channel). channelForRow == channelId here
    // (the read is channel-scoped), so it's the PK's channel member.
    { onConflict: "scope_id,puzzle_date,channel_id" },
  );
  if (upErr)
    console.error(
      "[card] live_cards upsert error (schema migrated?)",
      upErr.message,
    );

  // Launching here re-arms recaps: clear any /unsubscribe opt-out for this channel, so a channel
  // a moderator silenced starts getting the daily recap again now that play has resumed ("off
  // until someone starts the activity here again"). Keyed by the channel the card lives in
  // (channelForRow == the live_cards row's channel_id, which recap_channels reads). Best-effort
  // — a stale opt-out just costs one more night before the next launch clears it.
  const { error: optErr } = await db
    .from("recap_optouts")
    .delete()
    .match({ scope_id: scope, channel_id: channelForRow });
  if (optErr)
    console.warn("[card] recap_optouts clear failed", optErr.message);
}

// Send an ephemeral followup to the launcher at most once per (scope, player) per
// INSTALL_NUDGE_COOLDOWN_MS, recording the send in install_nudges. Shared by the bot-less
// "Add to Server" nudge and the can't-post-here permissions nudge — a guild is only ever one
// of those (bot absent vs. bot present but blocked), so they safely share the throttle table.
// The throttle row is claimed BEFORE the followup is sent, so a double-fired interaction can't
// double-nudge; a send that then fails just waits out the cooldown (better than risking spam the
// other way around). Any DB error — including the install_nudges table not existing yet — skips
// the nudge entirely: this is a growth/help nicety and must never noise up a launch. `tag` only
// labels the logs.
async function nudgeOnce(
  body: LaunchInteraction,
  scope: string,
  appId: string,
  token: string,
  payload: object,
  tag: string,
): Promise<void> {
  const u = body.member?.user ?? body.user;
  if (!u?.id) return;
  const db = admin();
  if (!db) return;

  const { data: row, error: selErr } = await db
    .from("install_nudges")
    .select("nudged_at")
    .eq("scope_id", scope)
    .eq("user_id", u.id)
    .maybeSingle();
  if (selErr) {
    console.warn(`[${tag}] skip: select failed (table missing?)`, selErr.message);
    return;
  }
  const last = row?.nudged_at ? Date.parse(row.nudged_at as string) : null;
  if (last != null && Date.now() - last < INSTALL_NUDGE_COOLDOWN_MS) return;

  const { error: upErr } = await db.from("install_nudges").upsert({
    scope_id: scope,
    user_id: u.id,
    nudged_at: new Date().toISOString(),
  });
  if (upErr) {
    console.warn(`[${tag}] skip: claim failed`, upErr.message);
    return;
  }

  const r = await fetch(interactionFollowupUrl(appId, token), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok)
    console.error(`[${tag}] followup failed`, { status: r.status }, await r.text().catch(() => ""));
  else console.log(`[${tag}] sent`, { scope, channel: body.channel_id, user: u.id });
}

// Show the launcher of a bot-less server the ephemeral "Add to Server" pitch — the highest-intent
// install moment there is (someone is actively playing where recaps can't post).
async function nudgeInstall(
  body: LaunchInteraction,
  scope: string,
  appId: string,
  token: string,
): Promise<void> {
  await nudgeOnce(body, scope, appId, token, installNudgePayload(appId), "nudge");
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
        data: {
          content: "Couldn’t build your share just now — try `/share` again.",
          flags: EPHEMERAL,
        },
      };
    }
    res.status(200).json(response);
    return;
  }

  // ACK first (Discord enforces a 3s deadline) — this is the LAUNCH_ACTIVITY that opens the
  // game.
  res.status(200).json(routeInteraction(body));

  // Then post the card — for a /connections command or a Play-button click. waitUntil keeps
  // the function alive past the response flush (a plain await after res.json() can be frozen
  // on Vercel).
  if (isLaunchCommand(body) || isPlayButton(body)) {
    waitUntil(
      postCard(body).catch((e) => {
        console.error("[card] threw", e instanceof Error ? e.message : e);
      }),
    );
  }
}
