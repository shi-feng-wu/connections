import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from './_admin.js';
import { bearerToken } from './_discord.js';
import { todayET } from './_nyt.js';
import { isLocalDev, verifyAuth } from './_session.js';

// The presence beat, split out of /api/roster so that the roster read can be a side-effect-free,
// CDN-cacheable per-room GET. Each client POSTs this on its ~30s tick; it stamps
// presence.last_seen for the caller so their green "online" ring stays lit on everyone else's
// (cached) roster within the 40s online TTL (ROSTER_ONLINE_TTL_MS). Presence is keyed
// (user_id, puzzle_date) — global per user per day — so one beat marks the player online in
// every room they belong to, exactly as the old inline heartbeat did.
//
// A write, so it barely touches egress (the read was the cost); a missed beat just blinks the
// ring for a cycle. Still ticket-gated here (a normal Bearer header — this route isn't cached,
// so unlike the roster read it has no reason to dodge Authorization).
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const auth = verifyAuth(bearerToken(req.headers.authorization));
  if (!isLocalDev() && !auth) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const uid = auth?.uid ?? null;
  const db = admin();
  // Standalone/dev (no identity or no store) has no ring to keep alive — soft success.
  if (!uid || !db) {
    res.status(204).end();
    return;
  }
  await db
    .from('presence')
    .upsert({ user_id: uid, puzzle_date: todayET(), last_seen: new Date().toISOString() })
    .then(
      () => {},
      () => {},
    );
  res.status(204).end();
}
