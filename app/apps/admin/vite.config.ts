import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The admin SPA. API calls are proxied to the Fastify server in dev so the
// browser talks to a single origin.
//
// @cis/survey is a CommonJS workspace package (built for Node consumers). Vite's
// bundler resolves it to its TypeScript source so its named exports are
// statically analysable; typecheck still uses the package's published types.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@cis/survey': fileURLToPath(new URL('../../packages/survey/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env['VITE_API_TARGET'] ?? 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
