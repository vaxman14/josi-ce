import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  build: {
    outDir: 'dist',
    // No sourcemaps in the shipped bundle: they are a copy of the source, and
    // CE images go to strangers' machines.
    sourcemap: false,
    rollupOptions: {
      output: { manualChunks: { react: ['react', 'react-dom', 'react-router-dom'] } },
    },
  },
  // Dev only. In production the API serves this bundle from its own origin, so
  // the session cookie and the CSRF pair work without any cross-origin rules.
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
});
