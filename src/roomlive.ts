import type { RealtimeChannel } from '@supabase/supabase-js';
import type { RosterDelta } from './player';
import { supabase } from './supabase';

// Live roster over Supabase Realtime, the fast path that replaces 30s polling when it's up.
// Mints a room-scoped JWT (/api/realtime-token), joins the room's private channel, and:
//   • Broadcast — progress/join deltas from the server (api/_realtime.ts) merge into the
//     roster the instant a guess lands, no poll, no per-viewer egress.
//   • Presence  — each client tracks itself, so the green "online" ring is the channel's
//     presence set (no heartbeat needed on this path).
//
// Purely additive over the backstop poll: if the token mint or socket fails — including the
// silent death when the Activity backgrounds — onLive(false) fires and App falls back to
// polling. resync() re-establishes the channel when the Activity returns to the foreground.

export type RoomLiveHandlers = {
  onDelta: (d: RosterDelta) => void; // a player's progress/identity changed
  onPresence: (onlineIds: Set<string>) => void; // who's connected right now
  onLive: (live: boolean) => void; // subscribed (true) or dropped/unavailable (false)
};

type ConnectOpts = {
  scope: string;
  selfId: string;
  accessToken: string;
  guildId: string | null;
  channelId: string | null;
  handlers: RoomLiveHandlers;
};

export class RoomLive {
  private channel: RealtimeChannel | null = null;
  private opts: ConnectOpts | null = null;
  private connecting = false;
  private live = false;

  // Idempotent: the first call opens the channel; later calls (e.g. a re-render) refresh the
  // handlers and no-op if already joined.
  async connect(opts: ConnectOpts): Promise<void> {
    this.opts = opts;
    await this.open();
  }

  private async open(): Promise<void> {
    if (!supabase || !this.opts || this.connecting || this.channel) return;
    this.connecting = true;
    const { scope, selfId, handlers } = this.opts;
    try {
      const token = await this.mintToken();
      if (!token) {
        handlers.onLive(false);
        return;
      }
      await supabase.realtime.setAuth(token);
      const channel = supabase.channel(`room:${scope}`, {
        config: { private: true, presence: { key: selfId } },
      });
      channel
        .on('broadcast', { event: 'progress' }, ({ payload }) => handlers.onDelta(payload as RosterDelta))
        .on('broadcast', { event: 'join' }, ({ payload }) => handlers.onDelta(payload as RosterDelta))
        .on('presence', { event: 'sync' }, () => handlers.onPresence(new Set(Object.keys(channel.presenceState()))))
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            this.live = true;
            void channel.track({ userId: selfId });
            handlers.onLive(true);
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            this.live = false;
            handlers.onLive(false);
          }
        });
      this.channel = channel;
    } catch {
      handlers.onLive(false);
    } finally {
      this.connecting = false;
    }
  }

  private async mintToken(): Promise<string | null> {
    if (!this.opts) return null;
    try {
      const r = await fetch('/api/realtime-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: this.opts.accessToken,
          guildId: this.opts.guildId,
          channelId: this.opts.channelId,
        }),
      });
      if (!r.ok) return null;
      const d = (await r.json()) as { token?: string };
      return typeof d.token === 'string' ? d.token : null;
    } catch {
      return null;
    }
  }

  // Re-establish after a likely drop (the socket can die silently on backgrounding without a
  // status callback). Healthy + connected → cheap no-op; otherwise tear down and rejoin.
  async resync(): Promise<void> {
    if (!supabase || !this.opts) return;
    if (this.live && this.channel && supabase.realtime.isConnected()) return;
    await this.teardown();
    await this.open();
  }

  private async teardown(): Promise<void> {
    this.live = false;
    if (supabase && this.channel) {
      try {
        await supabase.removeChannel(this.channel);
      } catch {
        /* ignore */
      }
    }
    this.channel = null;
  }

  async disconnect(): Promise<void> {
    this.opts = null;
    await this.teardown();
  }
}
