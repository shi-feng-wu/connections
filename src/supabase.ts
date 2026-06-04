import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Anon key is public by design (safe in the browser); Supabase RLS governs what
// it can do. Env vars unset (local dev, no project): `supabase` is null and the
// live-progress / leaderboard features disable themselves.
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Inside a Discord Activity, patchUrlMappings() (main.tsx) swaps window.WebSocket for a
// proxy that routes Supabase's realtime socket through the /supabase URL mapping. But
// this module creates the client at import time — BEFORE that patch runs — and
// realtime-js captures the WebSocket constructor at construction, so it would otherwise
// keep the *unpatched* original and connect straight to supabase.co. The Activity
// sandbox blocks that direct socket → the channel dies with "transport failure" (REST is
// unaffected: fetch is resolved per call, after the patch). Routing through this thin
// transport defers the lookup to connect time, so realtime uses the patched proxy.
// Standalone/dev (no patch) it's just the native WebSocket. Returning the socket from the
// constructor is intentional — `new ProxiedWebSocket(...)` yields a real WebSocket.
class ProxiedWebSocket {
  constructor(address: string | URL, subprotocols?: string | string[]) {
    return new window.WebSocket(address, subprotocols);
  }
}

export const supabase: SupabaseClient | null =
  url && key
    ? createClient(url, key, {
        realtime: {
          params: { eventsPerSecond: 5 },
          transport: ProxiedWebSocket as unknown as typeof WebSocket,
        },
      })
    : null;

export const supabaseEnabled = supabase !== null;
