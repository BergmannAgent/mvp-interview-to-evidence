import { defineConfig } from 'vite';

const backendTarget = process.env['BACKEND_PROXY_TARGET'] ?? 'http://localhost:3000';

export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true,
      },
      '/health': {
        target: backendTarget,
        changeOrigin: true,
      },
    },
  },
});
