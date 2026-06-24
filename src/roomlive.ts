import type { RealtimeChannel } from '@supabase/supabase-js';
import type { RosterDelta } from './player';
import { supabase } from './supabase';

// Live roster deltas over Supabase Realtime broadcast — the fast path. Mints a room-scoped JWT
// (/api/realtime-token), joins the room's private channel, and merges progress/join broadcasts
// (api/_realtime.ts) into the roster the instant a guess lands: no poll, no per-viewer egress.
//
// Broadcast ONLY — the online ring comes from Discord's own participant list (the SDK), not from
// here, so there's no Presence to track. Purely additive over the cold-start read: if the token
// mint or socket fails (including the silent death when the Activity backgrounds), live updates
// just stop and the next load / reconnect / safety-net read reconciles. resync() rejoins the
// channel when the Activity returns to the foreground.

// Ephemeral "which tiles am I picking" sent client→client over the WebSocket (channel.send),
// not the server REST path — so it rides the already-connected socket with the client's own
// room JWT. Pure cosmetic, never persisted.
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
      const token = await this.mintToken();
      if (!token) {
        console.warn('[roomlive] no token minted — staying on cold-start reads');
        return;
      }
      // NOT awaited: setAuth applies the token synchronously and flushes to the socket async;
      // awaiting it can hang if the proxied WebSocket can't establish, which would block the
      // subscribe below entirely.
      try {
        void supabase.realtime.setAuth(token);
      } catch (e) {
        console.error('[roomlive] setAuth threw', e);
      }
      console.info('[roomlive] subscribing to room:%s', scope);
      // PUBLIC channel (not private). On a private channel the realtime server re-evaluates the
      // realtime.messages RLS per recipient during broadcast fan-out, and it only passes for the
      // sender — so self:true works but no one else ever receives. Public has no per-message RLS,
      // so every subscriber gets every broadcast. self:true also lets a single tester confirm the
      // round-trip. The data here is the public "who's playing" roster, so a public room channel
      // matches the live-card exposure.
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

  // Push the caller's live tile selection to the room over the WebSocket (client→client, not the
  // server REST path). No-op until the channel is joined; a drop just means others stop seeing
  // your picks until you reselect.
  sendTiles(t: TilesMsg): void {
    if (!this.channel || !this.live) return;
    void this.channel.send({ type: 'broadcast', event: 'tiles', payload: t });
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
