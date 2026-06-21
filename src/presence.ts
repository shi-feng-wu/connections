import type { DiscordSDK } from "@discord/embedded-app-sdk";
import { MAX_MISTAKES, type Game } from "./game";

// Discord Rich Presence for the Activity: the "Playing Connections" card on the
// player's profile, with the puzzle number, live progress, and an elapsed timer.
// Requires the `rpc.activities.write` scope in the authorize() call (see App.tsx).
// Everything here is best-effort — a failure must never touch gameplay.

// The large image. Discord fetches this server-side to proxy it, so it must be the
// real public host (the in-Activity origin is the *.discordsays.com proxy, which
// Discord's servers can't reach — so we can't derive it from location.origin here).
// Set VITE_RP_ICON_URL to your deployment's /connections-icon.png, or to an uploaded
// Art Asset key from the Developer Portal (Rich Presence -> Art Assets). Unset, the
// card simply renders without a large image.
const ICON_URL = import.meta.env.VITE_RP_ICON_URL as string | undefined;

// "M:SS" from a duration. Used in the win line ("Solved in 4:32").
function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  return `${m}:${String(total % 60).padStart(2, "0")}`;
}

// The fields that drive the card. Pulled from the live Game; `solvedCount` is the
// groups deduced (not the back-fill a loss adds), matching the roster.
export type PresenceInput = {
  solvedCount: number;
  total: number;
  mistakesLeft: number;
  status: Game["status"];
  puzzleNo?: number;
  // When this player opened the Activity this session (ms epoch). The elapsed timer
  // counts from here — NOT the game's pinned started_at (first-ever open, used for
  // scoring), so the card reads "joined N min ago", not time-since-the-daily-reset.
  joinedAt: number;
  durationMs: number | null;
};

// A short key for "has the visible card changed?" — lets the caller skip redundant
// setActivity calls (Discord rate-limits them, and the board emits a snapshot on
// every tap). A solve, a mistake, the finish, or a new puzzle move the card;
// selection/elapsed churn doesn't appear here, so taps don't spam.
export function presenceSignature(p: PresenceInput): string {
  return `${p.status}|${p.solvedCount}|${p.mistakesLeft}|${p.puzzleNo ?? ""}`;
}

// Build the partial-activity payload. type 0 = "Playing", so the header reads
// "Playing Connections" (the app's name). The elapsed timer runs only while
// playing; once finished it's cleared (timestamps undefined) and the result line
// carries the time instead. Exported for unit tests.
export function buildActivity(p: PresenceInput) {
  // The activity card builds its text block from `state`, so `state` is ALWAYS set —
  // it's the status line. `details` is an optional headline shown only while playing;
  // a finished game is a single `state` line (no puzzle number, which made it too tall).
  // (Leaving `state` empty makes Discord render just the bare app name — that's the bug
  // that hid the finished card.)
  let details: string | undefined;
  let state: string;
  if (p.status === "won") {
    state = `Solved in ${fmtDuration(p.durationMs ?? 0)}`;
  } else if (p.status === "lost") {
    state = `${p.solvedCount}/${p.total} solved · out of guesses`;
  } else {
    details = "Solving today's puzzle.";
    const left = p.mistakesLeft;
    state = `${p.solvedCount}/${p.total} groups · ${left} ${left === 1 ? "mistake" : "mistakes"} left`;
  }

  // Attach only the keys we actually use. A present-but-undefined optional field can
  // make the Discord client drop the presence, so build incrementally rather than
  // spreading `undefined`s.
  const activity: {
    type: number;
    state: string;
    details?: string;
    timestamps?: { start: number };
    assets?: { large_image: string; large_text: string };
  } = { type: 0, state };
  if (details) activity.details = details;
  // Live "for MM:SS" only mid-game, counting from when this player joined this
  // session; omitted once done so the timer freezes.
  if (p.status === "playing") {
    activity.timestamps = { start: Math.floor(p.joinedAt / 1000) };
  }
  if (ICON_URL) {
    activity.assets = { large_image: ICON_URL, large_text: "NYT Connections" };
  }
  return activity;
}

// Push the current game state to the profile card. Swallows everything: if the SDK
// rejects (scope not granted, rate limit, bad image) the game is unaffected.
export async function setPresence(sdk: DiscordSDK, p: PresenceInput): Promise<void> {
  try {
    await sdk.commands.setActivity({ activity: buildActivity(p) });
  } catch (e) {
    console.warn("setActivity failed:", e);
  }
}

// Re-export so callers don't need to import MAX_MISTAKES just to reason about it.
export { MAX_MISTAKES };
