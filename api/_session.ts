import { createHmac, timingSafeEqual } from 'node:crypto';

// HMAC-signed game session, minted by /api/start and verified by /api/score.
// Binds a submission to a puzzle date and a server-measured start time, so a
// client can't score a puzzle it never started or fake a fast solve time. Leading
// underscore keeps Vercel from treating this file as a route.

const SECRET = process.env.SESSION_SECRET ?? '';

export type Session = { date: string; iat: number };

const b64url = (s: string): string => Buffer.from(s).toString('base64url');
const mac = (body: string): string =>
  createHmac('sha256', SECRET).update(body).digest('base64url');

export function signSession(s: Session): string {
  const body = b64url(JSON.stringify(s));
  return `${body}.${mac(body)}`;
}

export function verifySession(token: unknown): Session | null {
  if (!SECRET || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(mac(body));
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, 'base64url').toString()) as Session;
    return typeof s.date === 'string' && typeof s.iat === 'number' ? s : null;
  } catch {
    return null;
  }
}
