import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Anon key is public by design (safe in the browser); Supabase RLS governs what
// it can do. Env vars unset (local dev, no project): `supabase` is null and the
// leaderboard reads disable themselves.
//
// This client is REST-only (the season/all-time board RPCs in leaderboard.ts). Live updates don't
// touch Supabase at all anymore — they ride an SSE relay on Railway (see roomlive.ts /
// api/_realtime.ts), because a Discord Activity can't reliably hold the WebSocket Supabase
// Realtime needs. REST is unaffected: inside the Activity, fetch resolves per call AFTER
// patchUrlMappings (main.tsx) rewrites it through the /supabase URL mapping, so no socket and no
// transport shim is needed.
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null =
  url && key ? createClient(url, key) : null;
