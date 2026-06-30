import type { RosterDelta } from './player';

// Live roster over an SSE relay (scripts/relay.mjs on Railway) — the universal realtime path. A
// Discord Activity client can't reliably hold a WebSocket: the proxy/filters/web break the WS
// upgrade (confirmed — it dies on web and on filtered networks). But it CAN hold a long-lived SSE
// stream: plain HTTP, no upgrade, which streams cleanly through Discord's proxy even on the client
// where the WebSocket failed. So each client holds ONE EventSource to the relay via the `/relay`
// Developer-Portal URL mapping, and the relay fans out progress/join (pushed by the Vercel API)
// and tiles (pushed by clients). Supabase sees zero realtime traffic — the metered egress is gone.
//
// EventSource reconnects itself on a dropped stream (the relay sends a `retry:`), so there's no
// socket to babysit. Purely additive over the cold-start read: if the stream can't open, live
// updates just stop and the next load / safety-net read reconciles.

// Ephemeral "which tiles am I picking", POSTed to the relay, which stamps userId from the caller's
// ticket (so nobody can broadcast as someone else) and fans it out. Pure cosmetic, never persisted.
export type TilesMsg = { userId: string; channelId?: string | null; selected: string[] };

export type RoomLiveHandlers = {
  onDelta: (d: RosterDelta) => void; // a player's progress/identity changed (server push)
  onTiles: (t: TilesMsg) => void; // a player's live tile selection (client push)
  // The stream (re)connected. The relay buffers nothing, so anything pushed while we were
  // disconnected is gone — reconcile against the authoritative roster read on each (re)open.
  onReconnect?: () => void;
};

type ConnectOpts = {
  scope: string; // room key (g:<guild> / c:<channel>) — matches the room the API pushes to
  ticket: string; // signed x-ct auth ticket: gates the SSE sub and stamps tile authorship
  handlers: RoomLiveHandlers;
};

export class RoomLive {
  private es: EventSource | null = null;
  private opts: ConnectOpts | null = null;

  // Idempotent: the first call opens the stream; later calls refresh opts and no-op if open.
  async connect(opts: ConnectOpts): Promise<void> {
    this.opts = opts;
    this.open();
  }

  private open(): void {
    // Reopen only when there's no live stream. A transient drop is left to EventSource's own
    // auto-reconnect (readyState CONNECTING), but a TERMINAL close — a fatal /sub status (e.g. an
    // expired ticket → 401) puts it in CLOSED and it never retries — must be replaced here, else
    // live deltas stay dead for the session. Guarding on readyState (not just non-null) is the fix.
    if (!this.opts) return;
    if (this.es && this.es.readyState !== EventSource.CLOSED) return;
    if (this.es) this.es.close(); // drop a dead stream before replacing it
    const { scope, ticket, handlers } = this.opts;
    // Relative URL — the `/relay` URL mapping proxies it out to the Railway relay. EventSource is
    // NOT rewritten by patchUrlMappings, so we use the proxied path directly; and it can't set
    // headers, so the ticket rides in the query string.
    const url = `/relay/sub?room=${encodeURIComponent(scope)}&ct=${encodeURIComponent(ticket)}`;
    const es = new EventSource(url);
    // `open` fires on the first connect AND on every EventSource auto-reconnect. Skip the first
    // (the cold-start read already covered it) and reconcile on reconnects — the relay has no
    // replay, so deltas pushed during the gap are only recoverable via a fresh roster read.
    let opened = false;
    es.addEventListener('open', () => {
      if (opened) handlers.onReconnect?.();
      opened = true;
    });
    es.addEventListener('progress', (e) => {
      handlers.onDelta(JSON.parse((e as MessageEvent).data) as RosterDelta);
    });
    es.addEventListener('join', (e) => {
      handlers.onDelta(JSON.parse((e as MessageEvent).data) as RosterDelta);
    });
    es.addEventListener('tiles', (e) => {
      handlers.onTiles(JSON.parse((e as MessageEvent).data) as TilesMsg);
    });
    this.es = es;
  }

  // Push the caller's live tile selection to the relay (client→clients). The relay overwrites
  // userId from the ticket; a dropped POST just means others stop seeing your picks until you
  // reselect. No-op until connected.
  sendTiles(t: TilesMsg): void {
    if (!this.opts) return;
    void fetch('/relay/pub', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ct': this.opts.ticket },
      body: JSON.stringify({ room: this.opts.scope, event: 'tiles', payload: t }),
    }).catch(() => {
      /* cosmetic; ignore */
    });
  }

  // Re-establish the stream if it isn't healthy. open() no-ops on a live or auto-retrying stream
  // (no churn) but replaces one that has terminally CLOSED — the case EventSource won't recover on
  // its own (e.g. a fatal /sub status while we were backgrounded).
  async resync(): Promise<void> {
    if (!this.opts) return;
    this.open();
  }

  async disconnect(): Promise<void> {
    this.opts = null;
    if (this.es) {
      this.es.close();
      this.es = null;
    }
  }
}
