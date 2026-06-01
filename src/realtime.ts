import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';

// Live roster via Supabase Realtime Presence. Everyone in the same activity
// session joins a channel keyed by the Discord instance ID and tracks progress.

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
  // Tiles selected but not yet submitted; drives the emerald "picking…" halo.
  picking: boolean;
  done: 'won' | 'lost' | null;
  // Epoch ms. `startedAt` drives a local elapsed timer; `finishedAt` freezes it.
  startedAt: number;
  finishedAt: number | null;
};

let channel: RealtimeChannel | null = null;

// Authorize Realtime with a server-minted Supabase JWT (from a verified Discord
// identity). Call before joinRoom so private channels authorize; without it the
// room falls back to a public channel (local/dev).
export function setRealtimeAuth(token: string): void {
  supabase?.realtime.setAuth(token);
}

export function joinRoom(
  roomId: string,
  self: PlayerState,
  onSync: (players: PlayerState[]) => void,
  opts: { private?: boolean } = {},
): void {
  if (!supabase || channel) return;

  channel = supabase.channel(`room:${roomId}`, {
    // Private channels enforce realtime.messages RLS: only verified users can
    // join/broadcast presence in production.
    config: { private: opts.private ?? false, presence: { key: self.userId } },
  });

  channel
    .on('presence', { event: 'sync' }, () => {
      const state = channel!.presenceState<PlayerState>();
      // Each key holds an array of presences; take the latest per player.
      // Presence<PlayerState> is assignable to PlayerState.
      const players: PlayerState[] = Object.values(state).map((entries) => entries[0]).filter(Boolean);
      onSync(players);
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') void channel!.track(self);
    });
}

export async function updatePresence(self: PlayerState): Promise<void> {
  if (channel) await channel.track(self);
}

export function leaveRoom(): void {
  void channel?.unsubscribe();
  channel = null;
}
