// Shared plumbing for server-to-server self-calls between our own Vercel functions. A tiny caller
// (e.g. /api/interactions on launch, /api/guess on a counted guess) fires the HEAVY render in a
// SEPARATE function (/api/post-card, /api/refresh-card) so the caller stays lean and canvas-free.
// This is the common base-URL resolver plus the authenticated fire-and-forget POST. Leading
// underscore keeps Vercel from treating this as a route.

// Where our own functions live so we can self-call them. On Vercel, VERCEL_PROJECT_PRODUCTION_URL
// is the public production domain (no Deployment Protection); VERCEL_URL is the per-deploy URL.
// POST_CARD_URL overrides both for local `vercel dev` (e.g. http://localhost:3000).
export function internalBase(): string {
  if (process.env.POST_CARD_URL) return process.env.POST_CARD_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL)
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return '';
}

// Re-render the room's live "who's playing" card from the authoritative guess event. /api/guess
// fires this (best-effort, via waitUntil) on every counted guess — the SAME server-side trigger
// that drives the live roster broadcast — so the card's grids fill in during play, not only at the
// solve. The heavy @napi-rs/canvas render lives in /api/refresh-card (a separate function with the
// font assets bundled), so /api/guess stays canvas-free and its reveal path stays fast.
//
// Authenticated with INTERNAL_SECRET (mirrors /api/interactions -> /api/post-card): the secret
// proves the call came from our own function, which is why /api/refresh-card can trust the
// `finished` flag to bypass its throttle. Fire-and-forget by contract — a failed trigger just means
// the card waits for the next counted guess. MUST be called via waitUntil so it never delays the
// guess response.
// Returns whether /api/refresh-card answered ok (a 200 that wasn't a no-card/edit-failed reason).
// guess.ts ignores the result (fire-and-forget); the finalize cron uses it to decide whether to
// stamp finalized_at (so a failed flip retries on the next tick, still inside the window).
export async function triggerCardRefresh(input: {
  guildId: string | null;
  channelId: string | null;
  finished: boolean;
  finalize?: boolean; // set by the finalize cron to force past-tense caption before the window closes
  date?: string; // the card's puzzle_date — only the finalize cron sets it (ET-midnight boundary)
}): Promise<boolean> {
  const base = internalBase();
  const secret = process.env.INTERNAL_SECRET ?? '';
  if (!base || !secret) return false; // not configured (e.g. local dev without a secret) -> no card
  try {
    const r = await fetch(`${base}/api/refresh-card`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify(input),
    });
    if (!r.ok) return false;
    const body = (await r.json().catch(() => ({}))) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false; // best-effort: the next counted guess (or cron tick) fires another
  }
}
