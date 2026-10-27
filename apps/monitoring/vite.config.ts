import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  preview: {
    host: '0.0.0.0',
    port: 4174,
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env['MONITORING_BACKEND_URL'] ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
