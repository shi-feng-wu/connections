import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Anon key is public by design (safe in the browser); Supabase RLS governs what
// it can do. Env vars unset (local dev, no project): `supabase` is null and the
// live-progress / leaderboard features disable themselves.
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null =
  url && key ? createClient(url, key, { realtime: { params: { eventsPerSecond: 5 } } }) : null;

export const supabaseEnabled = supabase !== null;
