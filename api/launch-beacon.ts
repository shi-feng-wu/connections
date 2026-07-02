import type { VercelRequest, VercelResponse } from "@vercel/node";
import { query } from "./_query.js";

// Launch-funnel beacon. The client fires this from the inline boot script in index.html — the very
// first JS that runs inside the Activity iframe, BEFORE the Discord SDK handshake — and again once
// React mounts (src/main.tsx). Paired with the unconditional "[launch] ack" log in
// /api/interactions, it turns an otherwise-invisible launch failure into a measurable funnel:
//
//   ack logged + NO "boot" beacon      => Discord never opened the iframe (the LAUNCH_ACTIVITY ACK
//                                         was accepted but no document loaded — a launch-side drop)
//   "boot" beacon + NO "mounted" beacon => the JS bundle failed to load/evaluate (dead module graph)
//   "mounted" beacon + NO /api/token    => the ready()/authorize() handshake failed (blocked screen)
//
// Deliberately tiny, dependency-free, unauthenticated (it runs before any auth/identity exists) and
// node-free in spirit (no canvas/Supabase), so it cannot add latency or fail the boot. Always 204.
// All payload rides the query string (navigator.sendBeacon sends an empty body), so the body is
// never read.
export const config = { api: { bodyParser: false } };

export default function handler(req: VercelRequest, res: VercelResponse): void {
  const q = query(req);

  const data: Record<string, unknown> = {
    // "boot" | "mounted" | "boot-error" | "handshake-error" (App.tsx setupDiscord failure —
    // the mounted-but-no-token class, now explicit with a reason instead of infer-only)
    stage: q.get("stage") ?? "boot",
    embedded: q.get("embedded") === "1",
    // channel_id is the correlation key back to /api/interactions' "[launch] ack" — a launch whose
    // ack channel never produces a "boot" beacon is one Discord acked but never opened. guild is
    // null in a DM; instance_id is Discord's per-launch activity instance (present once it opens).
    channel: q.get("channel") || undefined,
    guild: q.get("guild") || undefined,
    instance: q.get("instance") || undefined,
    plat: q.get("plat") || undefined, // "web" | "ios" | "android" — lets us filter mobile launches
    t: q.get("t") ?? undefined, // client ms since navigation start (performance.now), best-effort
  };
  const reason = q.get("reason");
  if (reason) data.reason = reason.slice(0, 40); // boot-error: "asset"|"watchdog"; handshake-error: the failed step
  const failed = q.get("res");
  if (failed) data.res = failed.slice(0, 300); // the failed resource URL (boot-error only)
  // Age (s) of the activity instance at boot, decoded client-side from the instance_id
  // snowflake. Anything > a few seconds means this boot RECOVERED a previously stuck instance
  // (acked launches that never opened an iframe) — the direct counter for the stuck-channel bug.
  const iage = q.get("iage");
  if (iage) data.iage = iage.slice(0, 12);
  // handshake-error only: which attempt this document is (0 = the launch's original document,
  // 1 = the in-instance reload retry). An r=0 error whose instance later completes the funnel
  // means the reload rescue worked; an r=1 error is a dead instance (close is the only exit).
  const r = q.get("r");
  if (r) data.r = r.slice(0, 4);

  // One greppable line per launch stage. "[launch] beacon" + the existing "[launch] ack" together
  // make the client/server launch funnel visible in Vercel's runtime logs.
  console.log("[launch] beacon", data);
  res.status(204).end();
}
