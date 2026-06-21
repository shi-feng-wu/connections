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
  build: {
    rolldownOptions: {
      output: {
        // Split vendor code out of the app chunk: each group becomes its own
        // cacheable file, so app-code edits don't re-download react/supabase.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules\/(?:react|react-dom|scheduler)\// },
            { name: 'supabase', test: /node_modules\/@supabase\// },
            { name: 'vendor', test: /node_modules\// },
          ],
        },
      },
    },
  },
});
