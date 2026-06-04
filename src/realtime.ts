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
  const wantPrivate = opts.private ?? false;

  // Build + subscribe the presence channel. Factored so a private channel the
  // server rejects can retry once as public (see CHANNEL_ERROR below).
  const connect = (asPrivate: boolean): void => {
    const ch = supabase!.channel(`room:${roomId}`, {
      // Private channels enforce realtime.messages RLS: only verified users (a
      // server-minted JWT) can join/broadcast presence in production.
      config: { private: asPrivate, presence: { key: self.userId } },
    });
    channel = ch;

    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState<PlayerState>();
      // Each key holds an array of presences; take the latest per player.
      // Presence<PlayerState> is assignable to PlayerState.
      const players: PlayerState[] = Object.values(state).map((entries) => entries[0]).filter(Boolean);
      onSync(players);
    }).subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        void ch.track(self);
        return;
      }
      if (status === 'CHANNEL_ERROR') {
        // A private join only errors here when Realtime auth is misconfigured: the
        // JWT didn't validate (the server's SUPABASE_JWT_SECRET doesn't match the
        // project's JWT secret), or the realtime.messages RLS policies were never
        // applied to the project. Without a retry the roster silently shows only the
        // local player — which reads as "I can't see anyone else." Fall back once to
        // a public channel so live progress still works. LESS secure: presence is no
        // longer gated to verified users, so fix the root cause to restore private.
        console.warn('[realtime] presence CHANNEL_ERROR', { private: asPrivate, room: roomId }, err?.message ?? '');
        if (asPrivate && wantPrivate) {
          void ch.unsubscribe();
          channel = null;
          connect(false);
        }
      } else if (status === 'TIMED_OUT') {
        console.warn('[realtime] presence TIMED_OUT', { room: roomId });
      }
    });
  };

  connect(wantPrivate);
}

export async function updatePresence(self: PlayerState): Promise<void> {
  if (channel) await channel.track(self);
}

export function leaveRoom(): void {
  void channel?.unsubscribe();
  channel = null;
}
