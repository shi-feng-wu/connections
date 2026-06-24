// Edge gate for the cacheable /api/roster read.
//
// The roster GET is CDN-cached per room — one origin hit per room per ~20s instead of one
// per player per 30s, which is the whole point: it keeps Supabase egress proportional to
// active rooms, not players. But a CDN won't cache a response to a request carrying an
// `Authorization` (or `Cookie`) header — it treats it as private. So the signed auth ticket
// rides in a custom `x-ct` header instead, and this middleware verifies it on EVERY request.
// Routing Middleware runs ahead of the edge cache, so a cache HIT is gated too: nobody
// without a valid ticket ever gets a roster, exactly as the old per-request Bearer gate.
//
// This re-implements verifyAuth from api/_session.ts instead of importing it, because that
// module uses node:crypto, which the edge runtime doesn't provide — here the same
// HMAC-SHA256 / same token format / same 24h TTL is checked with Web Crypto. Keep the two in
// sync (both keyed by SESSION_SECRET).

export const config = { matcher: '/api/roster' };

const AUTH_MAX_AGE = 24 * 60 * 60 * 1000; // mirrors _session.ts

// `vercel dev` injects none of Vercel's system env vars, so "no VERCEL env at all" means
// local dev — where the gate is skipped, matching isLocalDev() and the standalone fallback
// the API routes already allow.
function isLocalDev(): boolean {
  return !process.env.VERCEL && !process.env.VERCEL_ENV;
}

const enc = new TextEncoder();

function bytesToB64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlToString(s: string): string {
  const b64 = (s.replace(/-/g, '+').replace(/_/g, '/')).padEnd(
    s.length + ((4 - (s.length % 4)) % 4),
    '=',
  );
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Constant-time compare of the presented vs expected signature (equal-length base64url).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyTicket(token: string | null): Promise<boolean> {
  const secret = process.env.SESSION_SECRET ?? '';
  if (!secret || !token) return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const macBuf = await crypto.subtle.sign('HMAC', key, enc.encode(body));
    if (!safeEqual(sig, bytesToB64Url(macBuf))) return false;
    const payload = JSON.parse(b64UrlToString(body)) as { uid?: unknown; iat?: unknown };
    if (typeof payload.uid !== 'string' || typeof payload.iat !== 'number') return false;
    const age = Date.now() - payload.iat;
    return age >= 0 && age <= AUTH_MAX_AGE;
  } catch {
    return false;
  }
}

export default async function middleware(request: Request): Promise<Response | undefined> {
  if (isLocalDev()) return undefined; // standalone dev: same skip the API routes use
  if (await verifyTicket(request.headers.get('x-ct'))) return undefined; // authorized → continue
  return new Response(JSON.stringify({ error: 'unauthenticated' }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
