import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Service-role Supabase client for trusted server writes. Bypasses RLS, so the
// anon key needs no write access (scores are insert-locked for anon). Returns null
// when the server env isn't configured, so callers degrade in dev. Never import
// from client code.
export function admin(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
