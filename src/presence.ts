import type { DiscordSDK } from "@discord/embedded-app-sdk";
import { MAX_MISTAKES, type Game } from "./game";

// Discord Rich Presence for the Activity: the "Playing Connections" card on the
// player's profile, with the puzzle number, live progress, and an elapsed timer.
// Requires the `rpc.activities.write` scope in the authorize() call (see App.tsx).
// Everything here is best-effort — a failure must never touch gameplay.

// The large image. Discord fetches this server-side to proxy it, so it must be the
// real public host (the in-Activity origin is the *.discordsays.com proxy, which
// Discord's servers can't reach). Override with VITE_RP_ICON_URL — e.g. point it at
// a different deploy, or set it to an uploaded Art Asset key from the Developer
// Portal (Rich Presence -> Art Assets) instead of a URL.
const ICON_URL =
  import.meta.env.VITE_RP_ICON_URL ??
  "https://connections-olive.vercel.app/connections-icon.png";

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
  startedAt: number; // ms epoch
  durationMs: number | null;
};

// A short key for "has the visible card changed?" — lets the caller skip redundant
// setActivity calls (Discord rate-limits them, and the board emits a snapshot on
// every tap). Selection/elapsed changes don't appear here, so taps don't spam.
export function presenceSignature(p: PresenceInput): string {
  return `${p.status}|${p.solvedCount}|${p.mistakesLeft}|${p.puzzleNo ?? ""}`;
}

// Build the partial-activity payload. type 0 = "Playing", so the header reads
// "Playing Connections" (the app's name). The elapsed timer runs only while
// playing; once finished the result line carries the time instead.
function buildActivity(p: PresenceInput) {
  const details = p.puzzleNo ? `Puzzle #${p.puzzleNo}` : "Daily puzzle";

  let state: string;
  if (p.status === "won") {
    state = `Solved in ${fmtDuration(p.durationMs ?? 0)}`;
  } else if (p.status === "lost") {
    state = `${p.solvedCount}/${p.total} solved · out of guesses`;
  } else {
    const left = p.mistakesLeft;
    state = `${p.solvedCount}/${p.total} groups · ${left} ${left === 1 ? "mistake" : "mistakes"} left`;
  }

  return {
    type: 0,
    details,
    state,
    // Live "for MM:SS" only mid-game; drop it when done so the timer freezes.
    ...(p.status === "playing"
      ? { timestamps: { start: Math.floor(p.startedAt / 1000) } }
      : {}),
    assets: {
      large_image: ICON_URL,
      large_text: "NYT Connections",
    },
  };
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
