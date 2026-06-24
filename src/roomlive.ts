import type { RealtimeChannel } from '@supabase/supabase-js';
import type { RosterDelta } from './player';
import { supabase } from './supabase';

// Live roster over Supabase Realtime broadcast — the fast path. Joins the room's PUBLIC channel
// and merges progress/join broadcasts (api/_realtime.ts, server→clients) plus tiles (client→
// clients) into the roster the instant they happen: no poll, no per-viewer egress.
//
// Broadcast ONLY — the online ring comes from Discord's own participant list (the SDK), not from
// here, so there's no Presence to track. Purely additive over the cold-start read: if the socket
// can't connect or dies, live updates just stop and the next load / safety-net read reconciles.
// resync() re-opens only if there's no channel; an existing one is left to supabase-js's own
// reconnect so we don't churn it.

// Ephemeral "which tiles am I picking" sent client→client over the WebSocket (channel.send),
// riding the already-connected socket. Pure cosmetic, never persisted.
export type TilesMsg = { userId: string; channelId?: string | null; selected: string[] };

export type RoomLiveHandlers = {
  onDelta: (d: RosterDelta) => void; // a player's progress/identity changed (server broadcast)
  onTiles: (t: TilesMsg) => void; // a player's live tile selection (client broadcast)
};

type ConnectOpts = {
  scope: string;
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

  // Idempotent: the first call opens the channel; later calls refresh opts and no-op if joined.
  async connect(opts: ConnectOpts): Promise<void> {
    this.opts = opts;
    await this.open();
  }

  private async open(): Promise<void> {
    if (!supabase || !this.opts || this.connecting || this.channel) return;
    this.connecting = true;
    const { scope, handlers } = this.opts;
    try {
      console.info('[roomlive] subscribing to room:%s', scope);
      // PUBLIC channel — no auth token, no setAuth. The supabase client's anon key authorizes the
      // socket, and a public channel has no RLS, so every subscriber receives every broadcast.
      // (A private channel re-evaluates realtime.messages RLS per recipient during fan-out and
      // only the sender passes, so others never receive — confirmed.) We deliberately do NOT call
      // setAuth: on a public channel it's unnecessary, and applying a token can force the socket
      // to reconnect mid-join, racing the subscribe and surfacing as a "transport failure" loop.
      const channel = supabase.channel(`room:${scope}`, {
        config: { broadcast: { self: true } },
      });
      channel
        .on('broadcast', { event: 'progress' }, (msg) => {
          console.info('[roomlive] rx progress', JSON.stringify(msg));
          handlers.onDelta((msg as { payload?: RosterDelta }).payload as RosterDelta);
        })
        .on('broadcast', { event: 'join' }, (msg) => {
          console.info('[roomlive] rx join', JSON.stringify(msg));
          handlers.onDelta((msg as { payload?: RosterDelta }).payload as RosterDelta);
        })
        .on('broadcast', { event: 'tiles' }, (msg) => {
          console.info('[roomlive] rx tiles', JSON.stringify(msg));
          handlers.onTiles((msg as { payload?: TilesMsg }).payload as TilesMsg);
        })
        .subscribe((status, err) => {
          // Diagnostic: SUBSCRIBED = connected + authorized; CHANNEL_ERROR/TIMED_OUT = the
          // socket or RLS rejected us; nothing logged = we never reached subscribe.
          console.info('[roomlive] status:', status, err ? `err=${err.message}` : '');
          this.live = status === 'SUBSCRIBED';
        });
      this.channel = channel;
    } catch (e) {
      console.error('[roomlive] open failed', e);
    } finally {
      this.connecting = false;
    }
  }

  // Push the caller's live tile selection to the room over the WebSocket (client→client, not the
  // server REST path). No-op until the channel is joined; a drop just means others stop seeing
  // your picks until you reselect.
  sendTiles(t: TilesMsg): void {
    if (!this.channel || !this.live) return;
    void this.channel.send({ type: 'broadcast', event: 'tiles', payload: t });
  }

  // Re-establish ONLY if we have no channel at all. supabase-js auto-reconnects an existing
  // channel on transport failure with its own backoff; tearing it down and recreating it on every
  // visibility/layout blip interrupts that retry and churns ("subscribing → error → closed →
  // subscribing…" forever), so we leave a live-or-retrying channel alone.
  async resync(): Promise<void> {
    if (!supabase || !this.opts || this.channel) return;
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
