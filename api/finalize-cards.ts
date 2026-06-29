import type { VercelRequest, VercelResponse } from '@vercel/node';
import { admin } from './_admin.js';
import { triggerCardRefresh } from './_internal.js';
import { TOKEN_EDIT_WINDOW_MS } from './_livecard.js';

// Finalize cron: flips a DM/group-DM card's "who's playing" caption to past tense just before its
// interaction-token edit window closes, so the frozen card reads "X was/were playing" instead of
// staying stuck in the present. A DM card has no bot — it can only be edited on the launcher's
// interaction token for ~15 min (TOKEN_EDIT_WINDOW_MS), and edits are event-driven (guesses/joins),
// so without this a quiet card would freeze mid-game in present tense. Guild cards need none of this:
// the bot can edit all day, so they flip to past tense the moment the whole roster finishes (handled
// inline in /api/refresh-card).
//
// Runs every couple of minutes (vercel.json cron, CRON_SECRET-authed). It only finds candidates and
// fires the flip — the actual render + Discord PATCH happens in /api/refresh-card (finalize:true),
// which carries the canvas addon, so this function stays tiny. The relay can't help here: it's a
// server→client SSE fan-out and can't make a Discord REST edit.

// Flip while the token is in this age band: old enough to be "about to expire", but with margin
// before TOKEN_EDIT_WINDOW_MS so the self-call's PATCH still lands inside the window. The band is
// wider than the cron cadence so a card is never skipped; finalized_at makes the flip fire once.
const FINALIZE_LEAD_MS = 3 * 60 * 1000; // start trying ~3 min before the window closes

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  // Vercel Cron sends Authorization: Bearer $CRON_SECRET (same secret api/cron-recap checks). The
  // `!secret ||` guard fails closed if it's unset rather than accepting a bare "Bearer ".
  const secret = process.env.CRON_SECRET ?? '';
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  const db = admin();
  if (!db) {
    res.status(200).json({ ok: false, reason: 'unavailable' });
    return;
  }

  try {
    const now = Date.now();
    // token_at in (now - WINDOW, now - (WINDOW - LEAD)] → within the editable window but inside the
    // final LEAD-ms run-up to expiry.
    const oldest = new Date(now - TOKEN_EDIT_WINDOW_MS).toISOString();
    const newest = new Date(now - (TOKEN_EDIT_WINDOW_MS - FINALIZE_LEAD_MS)).toISOString();
    const { data, error } = await db
      .from('live_cards')
      .select('scope_id, puzzle_date, channel_id')
      .like('scope_id', 'c:%') // DM/group-DM cards only (guild cards flip on finish, in refresh-card)
      .not('message_id', 'is', null)
      .is('finalized_at', null)
      .gt('token_at', oldest)
      .lte('token_at', newest);
    if (error) {
      res.status(500).json({ error: error.message });
      return;
    }

    const cards = (data as { scope_id: string; puzzle_date: string; channel_id: string }[] | null) ?? [];
    let flipped = 0;
    for (const card of cards) {
      // Force the past-tense caption via the existing render path; bypasses the edit throttle.
      const ok = await triggerCardRefresh({
        guildId: null,
        channelId: card.channel_id,
        finished: false,
        finalize: true,
        date: card.puzzle_date, // resolve by the card's own date (ET-midnight boundary safety)
      });
      // Only stamp finalized_at on a successful flip, so a transient failure retries on the next
      // tick (still inside the window). A flip that keeps failing just falls out of the band at
      // expiry and the card freezes in present tense — no worse than having no caption at all.
      if (ok) {
        await db
          .from('live_cards')
          .update({ finalized_at: new Date().toISOString() })
          .eq('scope_id', card.scope_id)
          .eq('puzzle_date', card.puzzle_date)
          .eq('channel_id', card.channel_id);
        flipped += 1;
      }
    }

    res.status(200).json({ ok: true, candidates: cards.length, flipped });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'error' });
  }
}
