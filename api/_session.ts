import { createHmac, timingSafeEqual } from 'node:crypto';

// HMAC-signed tokens, all keyed by SESSION_SECRET. Leading underscore keeps Vercel
// from treating this file as a route.
//
//  • Session — minted by /api/start, verified by /api/score. Binds a submission to
//    a puzzle date and a server-measured start time, so a client can't score a
//    puzzle it never started or fake a fast solve time.
//  • Auth — minted by /api/token after one Discord /users/@me check, verified by
//    /api/puzzle and /api/start. Vouches that a Discord identity was confirmed, so
//    those endpoints gate on a cheap HMAC instead of a Discord round-trip each call.
//  • State — minted by /api/install, verified by /api/discord-callback. A short-lived
//    OAuth `state` nonce so a code can only be redeemed by a flow this server began.

const SECRET = process.env.SESSION_SECRET ?? '';

export type Session = { date: string; iat: number };
export type Auth = { uid: string; iat: number };

// An auth ticket is good for a day — longer than any single sitting, short enough
// that a leaked one ages out.
const AUTH_MAX_AGE = 24 * 60 * 60 * 1000;

// An OAuth state nonce only has to outlive the user's trip through Discord's
// consent screen.
const STATE_MAX_AGE = 10 * 60 * 1000;

// `vercel dev` injects none of Vercel's system env vars (verified: VERCEL,
// VERCEL_ENV, NODE_ENV all unset locally), while every real deploy sets them. So
// "no Vercel env at all" means local dev — where the Discord-only gate is skipped
// for the standalone fallback. Anything else fails closed (gated).
export function isLocalDev(): boolean {
  return !process.env.VERCEL && !process.env.VERCEL_ENV;
}

const b64url = (s: string): string => Buffer.from(s).toString('base64url');
const mac = (body: string): string =>
  createHmac('sha256', SECRET).update(body).digest('base64url');

function sign(payload: object): string {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${mac(body)}`;
}

// Returns the parsed payload iff the signature checks out, else null. Shape
// validation is the caller's job (Session vs Auth are distinguished by fields).
function verify(token: unknown): unknown {
  if (!SECRET || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(body));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }
}

export function signSession(s: Session): string {
  return sign(s);
}

export function verifySession(token: unknown): Session | null {
  const s = verify(token) as Session | null;
  return s && typeof s.date === 'string' && typeof s.iat === 'number' ? s : null;
}

export function signAuth(a: Auth): string {
  return sign(a);
}

// OAuth `state`: a signed, self-expiring nonce. Carries only a timestamp — there is
// no per-user state to bind, just proof the callback's flow started here and is
// fresh (guards against a forged or replayed redirect).
export function signState(now: number = Date.now()): string {
  return sign({ iat: now });
}

export function verifyState(token: unknown): boolean {
  const s = verify(token) as { iat?: number } | null;
  if (!s || typeof s.iat !== 'number') return false;
  const age = Date.now() - s.iat;
  return age >= 0 && age <= STATE_MAX_AGE;
}

// Verify an auth ticket's signature, shape, and freshness. The `uid` (no `date`)
// also keeps a Session token from ever passing as an Auth ticket and vice versa.
export function verifyAuth(token: unknown): Auth | null {
  const a = verify(token) as Auth | null;
  if (!a || typeof a.uid !== 'string' || typeof a.iat !== 'number') return null;
  const age = Date.now() - a.iat;
  if (age < 0 || age > AUTH_MAX_AGE) return null;
  return a;
}
