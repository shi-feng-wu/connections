import { useEffect, useRef, useState } from "react";
import type { BoardRow } from "./leaderboard";

// "Position change since you last looked" for the standings tabs. The board itself
// carries no rank — it arrives ordered richest-first and rank is just the row index
// (see season.tsx). So to show a player moving up or down we keep a per-device snapshot
// of {user_id -> rank} from the last time this exact board (room + scope + window) was
// opened, and diff the current ranks against it. Per-device by design (localStorage):
// the agreed zero-backend implementation, so arrows can differ across devices and reset
// if storage is cleared.

const PREFIX = "connections:standingsRank:";

type RankSnapshot = Record<string, number>;

// {user_id -> 1-based rank} from the board's order. Mirrors season.tsx's `i + 1`.
export function rankMap(board: BoardRow[]): RankSnapshot {
  const out: RankSnapshot = {};
  board.forEach((r, i) => {
    out[r.user_id] = i + 1;
  });
  return out;
}

// Places moved since `prev` was taken: positive = climbed (smaller rank now), negative =
// slipped. null when there's no prior snapshot or the player wasn't in it (brand-new), so
// the UI shows no arrow. 0 (unchanged) also reads as "no arrow" at the render site.
export function rankDelta(
  prev: RankSnapshot | null | undefined,
  userId: string,
  rank: number,
): number | null {
  const was = prev?.[userId];
  return was != null ? was - rank : null;
}

function readSnapshot(key: string): RankSnapshot | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as RankSnapshot) : null;
  } catch {
    return null; // storage blocked / bad JSON — just show no arrows
  }
}

function writeSnapshot(key: string, snap: RankSnapshot): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(snap));
  } catch {
    /* storage blocked — fine, next open simply finds nothing to diff against */
  }
}

// Returns the ranks from the LAST time `key` was opened (frozen for this visit), then
// records the current ranks for next time. Keyed only on `key`, so mid-visit board churn
// (someone finishes a game and the order shifts) does NOT re-snapshot — arrows stay
// stable while you look and reflect movement *between* visits. A null key (e.g. the live
// tab, or no room) is a no-op that returns null, so the hook stays unconditional.
export function useRankSnapshot(
  key: string | null,
  board: BoardRow[],
): RankSnapshot | null {
  const [prev, setPrev] = useState<RankSnapshot | null>(null);
  // Latest board without making it an effect dep — we snapshot at open, not on churn.
  const boardRef = useRef(board);
  boardRef.current = board;

  useEffect(() => {
    if (!key) {
      setPrev(null);
      return;
    }
    setPrev(readSnapshot(key)); // freeze the previous visit's ranks for this session
    writeSnapshot(key, rankMap(boardRef.current)); // ...then persist current for next time
  }, [key]);

  return prev;
}
