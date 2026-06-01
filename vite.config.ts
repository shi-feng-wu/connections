import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `vercel dev` runs this Vite server and the /api functions together. In prod
// Vercel serves dist/ from its CDN and api/ as serverless functions.
export default defineConfig({
  plugins: [react(), tailwindcss()],
});
