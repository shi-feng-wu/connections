// The roster/player shape, shared by the Live-tab UI, the server roster (/api/roster),
// and App's local "self" overlay. Lived in realtime.ts until the roster moved off Supabase
// Realtime presence onto a plain /api/roster poll; the type outlived the module.

export type PlayerState = {
  userId: string;
  name: string;
  // Discord avatar URL. Absent for guests / no custom avatar; roster then shows
  // a color+initial placeholder.
  avatar?: string;
  mistakesLeft: number;
  solvedCount: number;
  // Solved difficulty levels (0-3); roster paints each mini-board row its color.
  solvedLevels: number[];
  // Hints revealed (−hintPenalty each on a win). Absent on older/local rows → 0.
  hintsUsed?: number;
  // Tiles selected but not yet submitted. Still carried, but the roster ring now
  // reflects the live heartbeat (see `online`), not this.
  picking: boolean;
  done: 'won' | 'lost' | null;
  // Epoch ms. `startedAt` drives a local elapsed timer; `finishedAt` freezes it.
  startedAt: number;
  finishedAt: number | null;
  // True while this player is "here right now" — i.e. their /api/roster heartbeat is
  // within the TTL (server-set), or it's you (always online while playing). Drives the
  // green "online" ring. A player who joined and then left stays in the roster with this
  // unset/false. On the Realtime path the live source is channel Presence, not this.
  online?: boolean;
  // Words this player currently has selected but hasn't submitted — live over Realtime
  // broadcast (Wordle-style "see them picking"). Client-only; never set by the server roster.
  pickingWords?: string[];
};

// A partial roster update fanned out over Realtime broadcast (api/_realtime.ts) on each guess
// (progress) or open (join). Carries only the fields that changed for one player; the client
// merges it onto the existing row by userId. `channelId` lets a Channel-view client ignore
// updates from other channels in the same guild. Identity (name) is present on a `join` so a
// brand-new player can be inserted; a `progress` delta for an unknown player triggers a
// backstop refetch instead.
export type RosterDelta = Partial<Omit<PlayerState, 'userId'>> & {
  userId: string;
  channelId?: string | null;
};
