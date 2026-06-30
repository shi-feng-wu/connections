import { patchUrlMappings } from '@discord/embedded-app-sdk';
import { createRoot } from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import './index.css';
import { App } from './App';

const params = new URLSearchParams(location.search);
const isEmbedded = params.has('frame_id');

// Inside a Discord Activity the sandbox blocks direct connections to external hosts: every
// request must go through Discord's *.discordsays.com proxy. patchUrlMappings rewrites fetch/XHR
// URLs for the Supabase host (REST only now — the season/all-time leaderboard reads) onto a
// `/supabase` path that the Developer Portal URL Mapping (/supabase -> <project>.supabase.co)
// proxies back out. The live-roster relay has its own `/relay` mapping but needs no patch: it's
// reached by relative paths (EventSource + fetch) that already resolve to the proxy origin.
// Standalone (no frame_id, dev only) connects directly, so the patch is skipped there.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
if (isEmbedded && supabaseUrl) {
  patchUrlMappings([{ prefix: '/supabase', target: new URL(supabaseUrl).host }]);
}

createRoot(document.getElementById('app')!).render(
  <>
    <App isEmbedded={isEmbedded} initialRoom={params.get('room') ?? 'local'} />
    {/* First-party Web Analytics; renders null and beacons /_vercel/insights/* on
        the same origin, so it rides Discord's proxy without a URL mapping. */}
    <Analytics />
  </>,
);

// Remove the pre-React boot spinner (index.html #cx-boot). React's first render already replaces
// #app's children, so this is belt-and-suspenders against any stray overlay.
document.getElementById('cx-boot')?.remove();

// The module graph evaluated and render() ran, so the bundle loaded fine — disarm the inline
// boot watchdog in index.html (it only fires if React never reached this line) and clear the
// one-shot reload guard so the NEXT launch starts fresh. Emit a "mounted" beacon: a launch with
// a "boot" beacon but no "mounted" one is a dead/blank bundle, vs one that mounts then fails the
// Discord handshake (which reaches /api/token). See api/launch-beacon.ts for the full funnel.
window.__appMounted = true;
window.__cxBootMounted?.();
try {
  // Same channel/guild correlation key as the inline boot beacon (index.html), so a launch's
  // funnel — ack → boot → mounted — can be matched end to end by channel_id.
  const plat = /Android/i.test(navigator.userAgent)
    ? 'android'
    : /iPhone|iPad|iPod/i.test(navigator.userAgent)
      ? 'ios'
      : 'web';
  const ctx =
    `&channel=${encodeURIComponent(params.get('channel_id') ?? '')}` +
    `&guild=${encodeURIComponent(params.get('guild_id') ?? '')}` +
    `&instance=${encodeURIComponent(params.get('instance_id') ?? '')}` +
    `&plat=${plat}`;
  navigator.sendBeacon?.(
    `/api/launch-beacon?stage=mounted&embedded=${isEmbedded ? 1 : 0}&t=${Math.round(performance.now())}${ctx}`,
  );
} catch {
  /* beacon is best-effort telemetry — never let it touch the boot */
}
