import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The desktop bundle.
 *
 * Built as a plain SPA rather than reusing the Next.js application: a till has no server
 * beside it, and the whole point of the desktop build is that it keeps selling when there
 * is nothing to render against. Business rules are shared through `@carl/domain`, so the
 * two clients cannot disagree about what a sale costs.
 */
export default defineConfig({
  plugins: [react()],
  // Fixed: `tauri.conf.json` points `devUrl` here, and a port that moves when something
  // else holds 1420 produces a desktop window that silently shows nothing.
  server: { port: 1420, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // A shop-floor machine is not a place to debug from, and a source map is a copy of the
    // source shipped to a device that gets stolen.
    sourcemap: false,
    target: 'esnext',
  },
  // Vite's dev server would otherwise try to resolve these to browser builds.
  clearScreen: false,
});
