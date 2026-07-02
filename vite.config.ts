import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Dev-only mirror of api/card-image.ts so the image-card puzzles (e.g. 2025-04-01)
// render their SVG glyphs under plain `vite dev` / the preview harness, where the
// serverless /api functions aren't running. Same host allowlist as the real route.
const ALLOWED_HOST =
  /^(games-assets\.storage\.googleapis\.com|games-phoenix-assets-prd\.s3\.[a-z0-9-]+\.amazonaws\.com)$/;
const cardImageDev = (): Plugin => ({
  name: 'dev-card-image-proxy',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/api/card-image', async (req, res) => {
      try {
        const raw = new URL(req.url ?? '', 'http://localhost').searchParams.get('u') ?? '';
        const url = new URL(raw);
        if (url.protocol !== 'https:' || !ALLOWED_HOST.test(url.host)) {
          res.statusCode = 400;
          res.end('host not allowed');
          return;
        }
        const upstream = await fetch(url.toString());
        const body = Buffer.from(await upstream.arrayBuffer());
        res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'image/svg+xml');
        res.end(body);
      } catch {
        res.statusCode = 502;
        res.end('error');
      }
    });
  },
});

// `vercel dev` runs this Vite server and the /api functions together. In prod
// Vercel serves dist/ from its CDN and api/ as serverless functions.
export default defineConfig({
  plugins: [react(), tailwindcss(), cardImageDev()],
  // Skew protection for a plain Vite app: tag every built asset URL with the deployment it
  // belongs to. Vercel routes `?dpl=`-tagged requests to that exact deployment, so an HTML
  // document held by Discord's proxy cache keeps fetching ITS OWN chunks after a newer deploy
  // is promoted. Without this there's a window at every promote where in-flight chunk requests
  // 404 — and Discord's proxy caches those 404s per POP for hours (the 2026-07-02 outage).
  // Needs Skew Protection enabled on the Vercel project. VERCEL_DEPLOYMENT_ID only exists on
  // Vercel builds; local builds return undefined and keep the default base-absolute URLs.
  experimental: {
    renderBuiltUrl(filename) {
      const dpl = process.env.VERCEL_DEPLOYMENT_ID;
      return dpl ? `/${filename}?dpl=${encodeURIComponent(dpl)}` : undefined;
    },
  },
  // NO vendor code-splitting (deliberately, since 2026-07-02): split chunks import each other
  // via bare relative specifiers ("./vendor-<hash>.js") that resolve WITHOUT the ?dpl= tag, so
  // only a single entry chunk keeps every network fetch deployment-pinned. The caching win the
  // old react/supabase/vendor split bought (~45KB gz re-download on app edits vs ~205KB) is not
  // worth reopening the promote-race window on the untagged chunk fetches.
});
