import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from './_admin.js';
import { bearerToken } from './_discord.js';
import { verifyAuth } from './_session.js';
import { isMissingTable, parseShareCustomId } from './_share.js';

// The INBOUND half of the share loop. When someone opens the Activity from a shared quick
// link, Discord hands their client `referrerId` (the sharer's user id) and `customId` (what
// we stamped on the link when it was minted — see /api/share-link). The client posts them
// here once at boot; this records who brought whom.
//
// v1 IS MEASUREMENT ONLY. No rewards, no unlocks, nothing the attribution can be farmed for —
// so the write can stay this simple. Rules:
//   • first-writer-wins: a player is attributed to exactly one referrer, ever. The primary key
//     on referred_user_id is the whole mechanism; a later link they click is a no-op.
//   • self-referrals are dropped (opening your own shared link is not a referral).
//   • the referrer is Discord's referrer_id when present, else the sharer encoded in our own
//     custom_id — a STATIC dev-portal link carries a custom_id with no sharer, and that's
//     recorded too (referrer_user_id null) so campaign links are measurable in the same table.
//
// Identity is the signed auth ticket (the /api/guess idiom), whose uid is the same Discord
// user id every other table keys on. No Discord round-trip: nothing here is worth one, and
// the boot path is latency-sensitive.

// Discord snowflakes. Anything else is a malformed/forged id and is not recorded as a person.
function snowflake(v: unknown): string | null {
  return typeof v === 'string' && /^\d{5,25}$/.test(v) ? v : null;
}

// Free text off the URL, so it's length-capped before it reaches the DB.
function shortText(v: unknown, max: number): string | null {
  return typeof v === 'string' && v ? v.slice(0, max) : null;
}

export type ReferralInput = { referrerId?: unknown; customId?: unknown; linkId?: unknown };

// Turn a boot payload into the row to write, or a reason not to. Pure, so the attribution
// rules are testable without a database.
export function resolveReferral(
  referredUserId: string,
  input: ReferralInput,
):
  | { ok: true; row: { referred_user_id: string; referrer_user_id: string | null; custom_id: string | null; link_id: string | null } }
  | { ok: false; reason: 'none' | 'self' } {
  const customId = shortText(input.customId, 200);
  const linkId = shortText(input.linkId, 100);
  // Discord's own referrer_id is authoritative; our custom_id carries the sharer as a fallback
  // for hosts that don't populate it.
  const referrer = snowflake(input.referrerId) ?? parseShareCustomId(customId)?.userId ?? null;
  if (!referrer && !customId) return { ok: false, reason: 'none' };
  if (referrer === referredUserId) return { ok: false, reason: 'self' };
  return {
    ok: true,
    row: {
      referred_user_id: referredUserId,
      referrer_user_id: referrer,
      custom_id: customId,
      link_id: linkId,
    },
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const auth = verifyAuth(bearerToken(req.headers.authorization));
  if (!auth?.uid) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  try {
    const body = (req.body ?? {}) as ReferralInput;
    const resolved = resolveReferral(auth.uid, body);
    if (!resolved.ok) {
      res.status(200).json({ ok: false, reason: resolved.reason });
      return;
    }
    const db = admin();
    if (!db) {
      res.status(200).json({ ok: false, reason: 'unavailable' });
      return;
    }
    // A plain insert IS first-writer-wins: the PK on referred_user_id rejects the second one,
    // and 23505 is the expected, uninteresting outcome for any returning player.
    const { error } = await db.from('referrals').insert(resolved.row);
    if (error) {
      if (error.code === '23505') {
        res.status(200).json({ ok: true, first: false });
        return;
      }
      if (isMissingTable(error.code)) {
        console.warn('[referral] referrals table missing; dropping attribution');
      } else {
        console.warn('[referral] write failed', error.code ?? error.message);
      }
      res.status(200).json({ ok: false, reason: 'unavailable' });
      return;
    }
    // Greppable: the acquisition loop actually converted. One line per newly attributed player.
    console.log('[referral] attributed', {
      referred: resolved.row.referred_user_id,
      referrer: resolved.row.referrer_user_id,
      custom: resolved.row.custom_id,
    });
    res.status(200).json({ ok: true, first: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
