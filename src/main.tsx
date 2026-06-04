import { patchUrlMappings } from '@discord/embedded-app-sdk';
import { createRoot } from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import './index.css';
import { App } from './App';

const params = new URLSearchParams(location.search);
const isEmbedded = params.has('frame_id');

// Inside a Discord Activity the sandbox blocks direct connections to external hosts:
// every request — including Supabase's realtime WebSocket and its REST/leaderboard
// calls — must go through Discord's *.discordsays.com proxy. patchUrlMappings rewrites
// fetch/WebSocket/XHR URLs for the Supabase host onto a `/supabase` path that the
// Developer Portal URL Mapping (/supabase -> <project>.supabase.co) proxies back out.
// Without it the WebSocket throws "the operation is insecure". Standalone (no frame_id,
// dev only) connects directly, so the patch is skipped there.
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
