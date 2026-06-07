import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Anon key is public by design (safe in the browser); Supabase RLS governs what
// it can do. Env vars unset (local dev, no project): `supabase` is null and the
// leaderboard reads disable themselves.
//
// This client is REST-only now (the season/all-time board RPCs in leaderboard.ts).
// The live roster used to ride Supabase Realtime through a proxied WebSocket here, but
// that socket silently died whenever the Discord Activity backgrounded and never
// recovered; the roster moved to a plain /api/roster poll instead. REST is unaffected:
// inside the Activity, fetch is resolved per call AFTER patchUrlMappings (main.tsx)
// rewrites it through the /supabase URL mapping, so no socket and no transport shim is
// needed.
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null =
  url && key ? createClient(url, key) : null;

export const supabaseEnabled = supabase !== null;
