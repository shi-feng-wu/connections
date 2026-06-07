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
  // unset/false.
  online?: boolean;
};
