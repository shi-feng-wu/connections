import { createHmac } from 'node:crypto';

// Server-side identity. Resolve the client's Discord OAuth token against Discord
// so user_id/name/avatar are authoritative; a client can't submit a score or join
// presence as someone else.

export type DiscordUser = { id: string; name: string; avatar?: string };

// Pull the token out of an `Authorization: Bearer <token>` header value. Returns
// null for anything else, so the caller fails closed.
export function bearerToken(authHeader: unknown): string | null {
  if (typeof authHeader !== 'string') return null;
  const m = authHeader.match(/^Bearer (.+)$/i);
  return m ? m[1] : null;
}

export async function fetchDiscordUser(accessToken: unknown): Promise<DiscordUser | null> {
  if (typeof accessToken !== 'string' || !accessToken) return null;
  try {
    const r = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const u = (await r.json()) as {
      id?: string;
      username?: string;
      global_name?: string | null;
      avatar?: string | null;
    };
    if (!u?.id) return null;
    return {
      id: u.id,
      name: u.global_name ?? u.username ?? 'Player',
      avatar: u.avatar
        ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`
        : undefined,
    };
  } catch {
    return null;
  }
}

// Guild ids the token's owner belongs to. /api/score uses this to authorize a
// guild-scoped write; guild ids are public, so without it a client could file
// under any server's board. Returns null on any failure (including a token
// lacking the `guilds` scope); the caller treats null as "not a member", failing
// closed.
export async function fetchUserGuildIds(accessToken: unknown): Promise<string[] | null> {
  if (typeof accessToken !== 'string' || !accessToken) return null;
  try {
    const r = await fetch('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const list = (await r.json()) as Array<{ id?: string }>;
    if (!Array.isArray(list)) return null;
    return list.map((g) => g.id).filter((id): id is string => typeof id === 'string');
  } catch {
    return null;
  }
}

// Short-lived Supabase JWT (HS256, role=authenticated) for one private Realtime
// room. Only verified Discord users get one, so presence can't be joined
// anonymously; the `room` claim scopes the token to a single channel (see the
// realtime.messages RLS policy in schema.sql), so a token for one room can't
// read or write any other. Null if unconfigured or no room given.
const b64url = (s: string): string => Buffer.from(s).toString('base64url');

export function mintSupabaseJWT(user: DiscordUser, room: string, ttlSec = 3600): string | null {
  const secret = process.env.SUPABASE_JWT_SECRET ?? '';
  if (!secret || !room) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      sub: user.id,
      role: 'authenticated',
      aud: 'authenticated',
      // scopes the token to one room: the RLS policy requires topic = 'room:' || this claim
      room,
      iat: now,
      exp: now + ttlSec,
    }),
  );
  const data = `${header}.${payload}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}
