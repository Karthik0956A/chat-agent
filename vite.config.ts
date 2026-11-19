import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: 'client',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            if ((err as any).code === 'ECONNRESET') return;
            console.error('[vite proxy error]:', err);
          });
        }
      }
    }
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true
  }
});
