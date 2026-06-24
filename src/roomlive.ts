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
    if (!this.opts || this.es) return;
    const { scope, ticket, handlers } = this.opts;
    // Relative URL — the `/relay` URL mapping proxies it out to the Railway relay. EventSource is
    // NOT rewritten by patchUrlMappings, so we use the proxied path directly; and it can't set
    // headers, so the ticket rides in the query string.
    const url = `/relay/sub?room=${encodeURIComponent(scope)}&ct=${encodeURIComponent(ticket)}`;
    // On a dropped stream EventSource auto-reconnects (the relay sends a retry:), so there's no
    // error handler to add — a failed open just retries until the stream comes back.
    const es = new EventSource(url);
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

  // EventSource handles its own reconnection, so this only re-opens a stream we explicitly closed
  // (e.g. a backgrounding teardown). A live or auto-retrying stream is left alone — no churn.
  async resync(): Promise<void> {
    if (!this.opts || this.es) return;
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
