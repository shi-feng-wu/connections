// Pure builders for the Discord messages the bot sends in response to interactions —
// the ephemeral command replies (/enable-posts, /donate, /unsubscribe), the mid-launch
// install/permission nudges, and the /share result card. No node/server imports, so
// BOTH api/interactions.ts (the live webhook) and src/preview.tsx (the offline visual
// harness) build the EXACT same payloads — the preview is the real message, not a
// replica that can drift (mirrors how src/card-draw.ts is shared for the PNG card).
//
// Each builder returns a `MessageData` — the `data` of a CHANNEL_MESSAGE_WITH_SOURCE
// interaction response (content + flags + components). routeInteraction wraps these in
// `{ type: 4, data }`; the preview renders them as Discord chrome.
import { Game, MAX_MISTAKES } from "./game.js";

// Discord message flags.
export const EPHEMERAL = 64; // "Only you can see this"
export const IS_COMPONENTS_V2 = 1 << 15; // render via the component tree, not content/embeds
// The interaction callback type that posts a message (used by routeInteraction + unsubscribeResult).
export const CHANNEL_MESSAGE_WITH_SOURCE = 4;

// Components V2 component type numbers (the framed /share card is built from these).
const CONTAINER = 17; // the bordered box (Wordle-style frame)
const TEXT_DISPLAY = 10; // a markdown text block
const SEPARATOR = 14; // a divider/spacer between blocks

// Ko-fi link target — KEEP IN SYNC with the footer link in src/infolinks.tsx.
export const KOFI_URL = "https://ko-fi.com/borgardev";
// Guild-install permissions for the "Add to Server" URL — KEEP IN SYNC with
// scripts/configure-install.mjs (View Channel | Send Messages | Embed Links | Attach
// Files | Read Message History).
const INSTALL_PERMISSIONS = "117760";

// A Discord message payload — the `data` block of an interaction response.
export type MessageData = {
  content?: string;
  flags?: number;
  components?: unknown[];
};

// Guild-install ("Add to Server") link: bot + commands scopes with the recap permissions.
// integration_type=0 opens the server picker directly instead of the two-option chooser.
export function installUrl(appId: string): string {
  return (
    `https://discord.com/oauth2/authorize?client_id=${appId}` +
    `&integration_type=0&scope=bot+applications.commands&permissions=${INSTALL_PERMISSIONS}`
  );
}

// One action row holding a single link button (style 5). Discord renders link buttons
// with an external-link glyph; the optional emoji sits before the label.
function linkButton(label: string, url: string, emoji?: string): unknown {
  const button: Record<string, unknown> = { type: 2, style: 5, label, url };
  if (emoji) button.emoji = { name: emoji };
  return { type: 1, components: [button] };
}

// "/enable-posts" where the bot is already guild-installed — nothing to do, recaps are on;
// if they're not showing, it's a channel-permission gap, so name what the bot needs.
export function enablePostsAlreadyEnabled(): MessageData {
  return {
    content:
      "The bot’s already in this server, so the recap should post here every night at reset.\n" +
      "-# Not seeing it? Make sure the bot has View Channel, Send Messages, and Attach Files in this channel.",
    flags: EPHEMERAL,
  };
}

// "/enable-posts" in a server without the bot: the casual pitch + a one-click "Add to Server"
// button. (Guild-only command, so there's no DM variant — it can't be run in a DM.)
export function enablePostsAddBot(appId: string): MessageData {
  return {
    content:
      "Add the bot to this server and it’ll post a nightly recap and a live who’s playing card.\n" +
      "-# Adding the bot needs the Manage Server permission.",
    flags: EPHEMERAL,
    components: [linkButton("Add to Server", installUrl(appId))],
  };
}

// "/donate": a private reply with the Ko-fi link button (the footer's "Help cover the
// server costs" link). Ephemeral — it's a personal nudge, not a channel post.
export function donateMessage(): MessageData {
  return {
    content:
      "Connections is free and ad-free — donations just cover the server costs that keep it running. Any amount helps, thank you!",
    flags: EPHEMERAL,
    components: [linkButton("Donate on Ko-fi", KOFI_URL, "☕")],
  };
}

// The /unsubscribe reply data, by outcome. "done" is a PUBLIC channel post (no ephemeral
// flag) so the channel sees the recap was turned off and how to undo/permanently mute it.
// The rest stay ephemeral so re-runs and edge cases don't post noise: "already" (recaps
// were already off and haven't been re-armed by a launch since), "no-guild" (a DM/non-guild
// surface with no channel recap to silence), and "error" (a DB hiccup).
export function unsubscribeMessage(
  kind: "done" | "already" | "no-guild" | "error",
): MessageData {
  if (kind === "done") {
    return {
      content:
        "Recaps are off for this channel now — they’ll come back automatically if someone launches Connections here again.\n" +
        "-# To mute them for good, take away the bot’s View Channel permission for this channel.",
    };
  }
  const content =
    kind === "already"
      ? "Recaps are already off here — they’ll come back if someone launches Connections in this channel again."
      : kind === "no-guild"
        ? "`/unsubscribe` only does something in a server channel — that’s the only place recaps post."
        : "Couldn’t update recaps just now — try `/unsubscribe` again in a moment.";
  return { content, flags: EPHEMERAL };
}

// The full /unsubscribe interaction response (the data wrapped in a message callback).
// Pure so it's unit-testable without a request. Exported (api/interactions.ts re-exports it).
export function unsubscribeResult(
  kind: "done" | "already" | "no-guild" | "error",
): object {
  return {
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: unsubscribeMessage(kind),
  };
}

// The ephemeral "add the bot" nudge a launcher gets in a server without the bot — the
// highest-intent install moment there is (someone is actively playing where recaps can't
// post). Unlike /enable-posts it fires mid-launch, so it leads with the live card — the
// payoff the launcher would see right now — and the recap rides along second.
export function installNudgePayload(appId: string): MessageData {
  return {
    content:
      "Add the bot to see a live who’s playing card while games are on, plus a nightly recap when the puzzle resets.\n" +
      "-# Adding it needs the Manage Server permission. Not an admin? Ask one to run `/enable-posts`.",
    flags: EPHEMERAL,
    components: [linkButton("Add to Server", installUrl(appId))],
  };
}

// The ephemeral nudge a launcher gets when the bot IS in the server but can't post in THIS
// channel — almost always a private channel the bot's role was never added to. We ask,
// privately, for exactly the permissions the recap/card posts need. No button: granting a
// channel's permissions is a Discord settings action, not an OAuth link.
export function missingPermsNudgePayload(): MessageData {
  return {
    content:
      "I’m in this server but can’t post in this channel, so the recap and live card won’t show up here.\n" +
      "Give the Connections bot (or its role) these permissions on this channel: View Channel, Send Messages, Attach Files.\n" +
      "-# Usually it’s a private channel the bot’s role isn’t in — check the channel’s settings → Permissions.",
    flags: EPHEMERAL,
  };
}

// "1:34" for a minute-plus solve, "42s" under a minute, "" when no duration is known.
function formatShareDuration(ms?: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

// The /share result as a Components V2 card — a plain bordered Container (Wordle's framed box, no
// accent stripe) holding a Wordle-style plain title line ("Connections #N x/4", x = groups solved
// out of four) above the colour-square grid (one row per guess, from Game.shareGrid), then a
// divider and a small subtext stat line. Returns the message `components` array (one container);
// the response pairs it with the IS_COMPONENTS_V2 flag — a V2 message carries NO content/embeds.
// Pure and finished-game-only — shareResponse gates on game.status before calling it.
export function shareCard(
  game: Game,
  opts: { puzzleNo?: number; durationMs?: number | null; score?: number | null } = {},
): object[] {
  const mistakes = MAX_MISTAKES - game.mistakesLeft;
  // Mistakes as the in-game 4-dot tracker: one circle per slot, light ⚪ for a remaining mistake
  // and dark ⚫ for a spent one (mirrors the board's light=remaining/dark=spent dots, remaining
  // first). So mistakes-remaining-out-of-4 reads at a glance: a flawless win is ⚪⚪⚪⚪, a loss
  // ⚫⚫⚫⚫.
  const dots = "⚪".repeat(game.mistakesLeft) + "⚫".repeat(mistakes);
  const stats: string[] = [dots];
  const dur = formatShareDuration(opts.durationMs);
  if (dur) stats.push(dur);
  if (typeof opts.score === "number") stats.push(`${opts.score} pts`);

  // Plain text, like Wordle's "Wordle 1828 4/6" — no bold/heading. groupsSolved excludes a loss's
  // forced back-fill, so a win is 4/4 and a loss is however many groups were actually deduced.
  const title = ["Connections", opts.puzzleNo ? `#${opts.puzzleNo}` : null, `${game.groupsSolved}/4`]
    .filter(Boolean)
    .join(" ");
  // Title, grid, and stats are separate blocks so spacers sit between them: equal line-less gaps
  // above AND below the grid (Wordle's breathing room, symmetric), then a thin divider before the
  // stat line.
  return [
    {
      type: CONTAINER,
      components: [
        { type: TEXT_DISPLAY, content: title },
        { type: SEPARATOR, divider: false, spacing: 1 },
        { type: TEXT_DISPLAY, content: game.shareGrid() },
        { type: SEPARATOR, divider: false, spacing: 1 },
        { type: SEPARATOR, divider: true, spacing: 1 },
        { type: TEXT_DISPLAY, content: `-# ${stats.join(" · ")}` },
      ],
    },
  ];
}
