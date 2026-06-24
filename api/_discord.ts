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

// Whether the bot is a member of a guild (i.e. the app is guild-installed there). Tri-state:
// false only on a definitive 403/404 ("missing access" / unknown guild — the bot isn't in
// it), null when it can't be determined (no token, rate limit, network), so callers never
// pitch an install to a server that might already have the bot. /api/join forwards this to
// the app, which keys the loading tip + end-screen recap prompt off it. Cached per warm
// lambda — install status barely moves, and this otherwise costs a Discord call per open.
const BOT_GUILD_TTL_MS = 5 * 60 * 1000;
const botGuildCache = new Map<string, { val: boolean; at: number }>();

export async function botInGuild(guildId: string, botToken: string): Promise<boolean | null> {
  if (!guildId || !botToken) return null;
  const hit = botGuildCache.get(guildId);
  if (hit && Date.now() - hit.at < BOT_GUILD_TTL_MS) return hit.val;
  try {
    const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (r.ok || r.status === 403 || r.status === 404) {
      const val = r.ok;
      botGuildCache.set(guildId, { val, at: Date.now() });
      return val;
    }
    return null;
  } catch {
    return null;
  }
}

// Server (guild) name via the bot token, for the recap card's room eyebrow. Best-effort:
// null on any failure (bot not in the guild, rate limit, etc.) → the recap falls back to
// the static "DAILY RECAP" label. Needs the bot to be a member of the guild.
export async function fetchGuildName(guildId: string, botToken: string): Promise<string | null> {
  if (!guildId || !botToken) return null;
  try {
    const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!r.ok) return null;
    const g = (await r.json()) as { name?: string };
    return typeof g.name === 'string' && g.name ? g.name : null;
  } catch {
    return null;
  }
}

// Channel name via the bot token, for the recap card's room eyebrow. Best-effort (null on
// failure). The bot is posting the recap to this channel, so it normally has access.
export async function fetchChannelName(channelId: string, botToken: string): Promise<string | null> {
  if (!channelId || !botToken) return null;
  try {
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!r.ok) return null;
    const c = (await r.json()) as { name?: string };
    return typeof c.name === 'string' && c.name ? c.name : null;
  } catch {
    return null;
  }
}

