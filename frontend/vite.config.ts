import { defineConfig } from 'vite';

// Seven Keys — Phase 1 dev/build configuration.
// The game is a plain TypeScript + Three.js SPA; no framework plugin is required.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
