import { waitUntil } from "@vercel/functions";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  installNudgePayload,
  missingPermsNudgePayload,
} from "../src/discord-messages.js";
import type { Puzzle } from "../src/game.js";
import { canonicalScope } from "../src/scope.js";
import type { CardPlayer } from "./_card.js";
import {
  botCardUrl,
  CARD_POST_COOLDOWN_MS,
  cardPayload,
  interactionFollowupUrl,
  interactionMessageUrl,
  playerFinished,
  playingLine,
  sendCard,
  tokenStillEditable,
  withGrids,
  withinPostCooldown,
} from "./_livecard.js";

// The "who's playing" card renderer, split out of /api/interactions so the latency-critical launch
// ACK function stays tiny (no @napi-rs/canvas native addon in its deployment) and reliably answers
// Discord's 3s deadline even on a cold start. /api/interactions sends the type-12 ACK itself
// (APP_HANDLER — Discord never posts its own card), then fires a fire-and-forget internal call here
// with the verified interaction (token included), and this function renders + posts the card in the
// background. Authenticated by INTERNAL_SECRET (mirrors cron-recap's Bearer check), NOT the Discord
// signature — the secret proves the call came from our own interactions function.

const MESSAGE_COMPONENT = 3;

// Ephemeral "add the bot" nudge (installNudgePayload) for a launch in a server without the
// bot — re-shown to the same player in the same room at most once per cooldown.
const INSTALL_NUDGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// Discord permission bits the card/recap need in a channel (compared as BigInt — the bitfield
// exceeds 2^53). Both the live "who's playing" card and the nightly recap are PNG attachments,
// so Attach Files is required alongside View Channel + Send Messages.
const PERM_ADMINISTRATOR = 1n << 3n;
const PERM_VIEW_CHANNEL = 1n << 10n;
const PERM_SEND_MESSAGES = 1n << 11n;
const PERM_ATTACH_FILES = 1n << 15n;

// The card is best-effort, and Discord returns statuses that are EXPECTED rather than bugs:
// 403 (the bot lacks or lost access to the channel), 404 (the interaction webhook/message expired
// or was deleted), 429 (the "edits to messages older than 1 hour" rate limit). Log those at warn so
// the Vercel runtime-errors view stays a list of REAL problems; anything else (5xx, etc.) keeps
// error level. Mirrors the per-status handling the DM-card path already used inline.
const cardLog = (status: number): ((...args: unknown[]) => void) =>
  status === 403 || status === 404 || status === 429 ? console.warn : console.error;

type DiscordUserLite = {
  id?: string;
  username?: string;
  global_name?: string | null;
  avatar?: string | null;
};
type LaunchInteraction = {
  type?: number;
  data?: { custom_id?: string; name?: string };
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
  // The bot's already-computed effective permissions in the channel this interaction came from.
  app_permissions?: string;
};

// Whether this interaction was authorized ONLY as a user install — the app is on the user's
// account, not installed to this guild, so the bot isn't a member and can't post/edit the card.
// "0" = GUILD_INSTALL, "1" = USER_INSTALL; an absent/unexpected field proceeds. Exported for tests.
export function isUserInstallOnly(body: {
  authorizing_integration_owners?: Record<string, string>;
}): boolean {
  const owners = body.authorizing_integration_owners;
  if (!owners || typeof owners !== "object") return false;
  return "1" in owners && !("0" in owners);
}

// Whether the bot can post the card/recap in the channel an interaction came from, read straight
// from Discord's app_permissions. Administrator implies everything. Absent/unparseable fails OPEN
// (returns true), matching the "proceed when unsure" posture elsewhere. Exported for tests.
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

// Post or edit the "who's playing" card in a DM/group DM, where there's no bot to keep it live.
// It rides the launcher's interaction-followup token (no bot/channel perms): the first launch in a
// 2h window posts a fresh card; later launches/Play-clicks within that window edit it in place to
// merge whoever joined — but only while the CREATING launch's token is still editable (~15 min),
// after which the card freezes (its Play button still works). Identity is the Discord-verified
// interaction, so edits can't be spoofed. Best-effort — runs after the launch ACK, never blocks play.
async function postDmCard(
  body: LaunchInteraction,
  scope: string,
  channelId: string,
  appId: string,
  token: string,
): Promise<void> {
  const { admin } = await import("./_admin.js");
  const { fetchPuzzle, todayET } = await import("./_nyt.js");
  const { mergePlayer, renderRoster } = await import("./_card.js");
  const db = admin();
  if (!db) {
    console.warn("[dm-card] skip: no db (admin client unconfigured)");
    return;
  }

  const u = body.member?.user ?? body.user;
  if (!u?.id) {
    console.warn("[dm-card] skip: no user on interaction");
    return;
  }
  const player: CardPlayer = {
    id: u.id,
    name: u.global_name ?? u.username ?? "Player",
    avatar: u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`
      : null,
  };

  const date = todayET();
  const { data: row, error: selErr } = await db
    .from("live_cards")
    .select("players, message_id, posted_at, interaction_token, token_at")
    .eq("scope_id", scope)
    .eq("puzzle_date", date)
    .eq("channel_id", channelId)
    .maybeSingle();
  if (selErr)
    console.error("[dm-card] live_cards select error", selErr.message);

  let puzzle: Puzzle | null = null;
  try {
    puzzle = await fetchPuzzle(date);
  } catch {
    /* grids render blank without a puzzle */
  }
  // A launcher who already finished today isn't playing anymore — don't (re)add them or post on
  // their click (mirrors the guild card). Puzzle null = can't tell → treat as still playing.
  if (puzzle && (await playerFinished(db, puzzle, player.id, date))) {
    console.log("[dm-card] skip: launcher already finished today", {
      scope,
      user: player.id,
    });
    return;
  }

  const now = Date.now();
  const messageId = (row?.message_id as string | null | undefined) ?? null;
  const editToken =
    (row?.interaction_token as string | null | undefined) ?? null;
  const withinCooldown = withinPostCooldown(
    row?.posted_at as string | null | undefined,
    now,
  );
  const startingFresh = !messageId || !withinCooldown;
  const existing: CardPlayer[] = Array.isArray(row?.players)
    ? (row.players as CardPlayer[])
    : [];

  if (!startingFresh) {
    // In the 2h window: edit the existing card in place — but only while the creating token is
    // still alive. Once it's expired the card is frozen (we can't edit it and won't repost until
    // the window rolls); its Play button keeps working, so just stop here.
    if (
      !editToken ||
      !messageId ||
      !tokenStillEditable(row?.token_at as string | null | undefined, now)
    ) {
      console.log("[dm-card] skip: card frozen (token expired)", {
        scope,
        channel: channelId,
      });
      return;
    }
    const players = mergePlayer(existing, player).players;
    const renderPlayers = puzzle
      ? await withGrids(db, puzzle, date, players)
      : players;
    const content = playingLine(players.map((p) => p.name), false);
    const png = await renderRoster(renderPlayers, {
      puzzleNo: puzzle?.id,
      puzzleDate: date,
    });
    const er = await sendCard(
      interactionMessageUrl(appId, editToken, messageId),
      cardPayload({ content }),
      png,
      "PATCH",
      "card.png",
    );
    if (!er.ok) {
      // 404 = the launcher deleted the card (Unknown Message) or the token lapsed mid-window —
      // expected for a best-effort DM card, so just stop (don't repost something they removed).
      const log = cardLog(er.status);
      log(
        "[dm-card] edit failed",
        { status: er.status },
        await er.text().catch(() => ""),
      );
      return;
    }
    await db
      .from("live_cards")
      .update({ players, updated_at: new Date().toISOString() })
      .eq("scope_id", scope)
      .eq("puzzle_date", date)
      .eq("channel_id", channelId);
    console.log("[dm-card] edited", {
      scope,
      channel: channelId,
      players: players.length,
    });
    return;
  }

  // Fresh card (none yet, or the 2h window rolled): reset the roster to this launcher, post on
  // this launch's token, and store the token + token_at so the next ~15 min of joins can edit it.
  const players = [player];
  const renderPlayers = puzzle
    ? await withGrids(db, puzzle, date, players)
    : players;
  const content = playingLine(players.map((p) => p.name), false);
  const png = await renderRoster(renderPlayers, {
    puzzleNo: puzzle?.id,
    puzzleDate: date,
  });
  const r = await sendCard(
    interactionFollowupUrl(appId, token),
    cardPayload({ content }),
    png,
    "POST",
    "card.png",
  );
  if (!r.ok) {
    // 404 (Unknown Webhook) = the launcher's interaction token expired before this background post
    // ran (a slow cold start) — expected, nothing to retry. Other failures are unexpected.
    const log = cardLog(r.status);
    log(
      "[dm-card] post failed",
      { status: r.status },
      await r.text().catch(() => ""),
    );
    return;
  }
  const newId = ((await r.json()) as { id?: string }).id ?? null;
  console.log("[dm-card] posted", {
    scope,
    channel: channelId,
    messageId: newId,
    players: players.length,
  });

  const nowIso = new Date().toISOString();
  const { error: upErr } = await db.from("live_cards").upsert(
    {
      scope_id: scope,
      puzzle_date: date,
      channel_id: channelId,
      players,
      message_id: newId,
      interaction_token: token,
      token_at: nowIso,
      posted_at: nowIso,
      updated_at: nowIso,
    },
    { onConflict: "scope_id,puzzle_date,channel_id" },
  );
  if (upErr) console.error("[dm-card] live_cards upsert error", upErr.message);
}

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

  // The "who's playing" card is normally kept live all day by the bot, so guild channels get the
  // bot-edited version below. A DM/group DM has no bot — but we can post the SAME card on the
  // launcher's interaction-followup token (no bot/perms needed) and edit it as people join for the
  // token's ~15-min window, after which it freezes. (Bot-less + no-perms servers get this in a
  // later phase; for now they keep the behaviour below.)
  const guildId = typeof body.guild_id === "string" ? body.guild_id : null;
  const channelId =
    typeof body.channel_id === "string"
      ? body.channel_id
      : typeof body.channel?.id === "string"
        ? body.channel.id
        : null;
  const scope = canonicalScope(guildId, channelId);
  if (!scope || !channelId) {
    console.warn("[card] skip: no scope/channel", {
      guildId,
      channelId,
      scope,
    });
    return;
  }
  if (!scope.startsWith("g:")) {
    // DM / group DM — no guild, no bot. Post (or edit, within the token window) the card and stop.
    await postDmCard(body, scope, channelId, appId, token);
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
  const canPost = botCanPostInChannel(body.app_permissions);
  if (!canPost) {
    console.log("[card] bot lacks post permission in channel; nudging", {
      scope,
      channel: channelId,
    });
    await nudgeOnce(
      body,
      scope,
      appId,
      token,
      missingPermsNudgePayload(),
      "perms",
    );
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

  const { admin } = await import("./_admin.js");
  const { fetchPuzzle, todayET } = await import("./_nyt.js");
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
  // to the room card or post a new one on their click.
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
  // A launch/join means someone's playing → present tense. (A guild card flips to past tense in
  // /api/refresh-card once the whole roster has finished.)
  const content = playingLine(players.map((p) => p.name), false);
  const png = await renderRoster(renderPlayers, {
    puzzleNo: puzzle?.id,
    puzzleDate: date,
  });

  // Cooldown — at most one card per room every CARD_POST_COOLDOWN_MS (2h). A launch within
  // that window edits the current card in place (bot token); a deleted card (404) falls
  // through to a fresh post. Skip when the bot can't post here (app_permissions already told
  // us — we nudged above): a bot-token PATCH would only 403 "Missing Access".
  if (messageId && withinCooldown && botToken && canPost) {
    const er = await sendCard(
      botCardUrl(cardChannel, messageId),
      cardPayload({ content }),
      png,
      "PATCH",
      "card.png",
      { Authorization: `Bot ${botToken}` },
    );
    if (er.status === 404) messageId = null;
    else if (!er.ok)
      cardLog(er.status)(
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
    // A button card is a bot-token reply, so it needs channel perms. If the bot can't post here
    // (app_permissions already told us — we nudged above), don't bother: it would only 403. A
    // command launch's followup rides the interaction token (no perms), so it still proceeds.
    if (viaButton && !canPost) {
      console.log(
        "[card] skip: bot can't post button card here (nudged for perms)",
        {
          scope,
          channel: channelId,
        },
      );
      return;
    }
    let r: Response;
    if (viaButton) {
      const replyTo = body.message?.id
        ? { messageId: body.message.id, channelId }
        : undefined;
      r = await sendCard(
        botCardUrl(channelId),
        cardPayload({ content, replyTo }),
        png,
        "POST",
        "card.png",
        botToken ? { Authorization: `Bot ${botToken}` } : undefined,
      );
      // The bot can post but lacks Read Message History, so it can't reply to the launch message
      // (403, code 160002). Retry once as a plain card (no reply reference) so it still lands.
      if (!r.ok && r.status === 403 && replyTo) {
        r = await sendCard(
          botCardUrl(channelId),
          cardPayload({ content }),
          png,
          "POST",
          "card.png",
          botToken ? { Authorization: `Bot ${botToken}` } : undefined,
        );
      }
    } else {
      r = await sendCard(
        interactionFollowupUrl(appId, token),
        cardPayload({ content }),
        png,
        "POST",
        "card.png",
      );
    }
    if (!r.ok) {
      cardLog(r.status)(
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
    { onConflict: "scope_id,puzzle_date,channel_id" },
  );
  if (upErr)
    console.error(
      "[card] live_cards upsert error (schema migrated?)",
      upErr.message,
    );

  // Launching here re-arms recaps: clear any /unsubscribe opt-out for this channel.
  const { error: optErr } = await db
    .from("recap_optouts")
    .delete()
    .match({ scope_id: scope, channel_id: channelForRow });
  if (optErr) console.warn("[card] recap_optouts clear failed", optErr.message);
}

// Send an ephemeral followup to the launcher at most once per (scope, player) per
// INSTALL_NUDGE_COOLDOWN_MS, recording the send in install_nudges. Shared by the bot-less
// "Add to Server" nudge and the can't-post-here permissions nudge. The throttle row is claimed
// BEFORE the followup is sent, so a double-fired interaction can't double-nudge. Any DB error
// skips the nudge entirely — it's a growth/help nicety and must never noise up a launch.
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
  const { admin } = await import("./_admin.js");
  const db = admin();
  if (!db) return;

  const { data: row, error: selErr } = await db
    .from("install_nudges")
    .select("nudged_at")
    .eq("scope_id", scope)
    .eq("user_id", u.id)
    .maybeSingle();
  if (selErr) {
    console.warn(
      `[${tag}] skip: select failed (table missing?)`,
      selErr.message,
    );
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
  if (!r.ok) {
    // 404 (Unknown Webhook) = the launcher's interaction token lapsed before this best-effort
    // nudge fired — expected, not an error (the nudge must never noise up a launch).
    const log = cardLog(r.status);
    log(
      `[${tag}] followup failed`,
      { status: r.status },
      await r.text().catch(() => ""),
    );
  } else
    console.log(`[${tag}] sent`, {
      scope,
      channel: body.channel_id,
      user: u.id,
    });
}

// Show the launcher of a bot-less server the ephemeral "Add to Server" pitch.
async function nudgeInstall(
  body: LaunchInteraction,
  scope: string,
  appId: string,
  token: string,
): Promise<void> {
  await nudgeOnce(
    body,
    scope,
    appId,
    token,
    installNudgePayload(appId),
    "nudge",
  );
}

// Internal endpoint: /api/interactions calls this (server-to-server) after it has ACKed the launch,
// forwarding the verified interaction. We authenticate with INTERNAL_SECRET (the Discord signature
// was already checked upstream), ACK fast, then render + post the card in the background.
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
  const body = (req.body ?? {}) as LaunchInteraction;
  // ACK the internal caller immediately so /api/interactions isn't held open; the render runs in
  // this function's own background.
  res.status(200).json({ ok: true });
  waitUntil(
    postCard(body).catch((e) => {
      console.error("[card] threw", e instanceof Error ? e.message : e);
    }),
  );
}
