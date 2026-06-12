import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `vercel dev` runs this Vite server and the /api functions together. In prod
// Vercel serves dist/ from its CDN and api/ as serverless functions.
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
