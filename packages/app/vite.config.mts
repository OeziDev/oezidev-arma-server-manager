import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.join(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@core-constants': path.join(__dirname, '../core/src/model/constants.ts'),
      '@core-naming': path.join(__dirname, '../core/src/steam/naming.ts'),
      '@core-rcon': path.join(__dirname, '../core/src/rcon/parse.ts'),
    },
  },
  build: {
    outDir: path.join(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  server: { port: 5173, strictPort: true },
});
