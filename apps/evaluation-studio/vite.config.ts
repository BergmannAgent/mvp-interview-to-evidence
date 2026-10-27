import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  preview: {
    host: '0.0.0.0',
    port: 4175,
  },
  server: {
    host: '0.0.0.0',
    port: 5175,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env['EVALUATION_STUDIO_BACKEND_URL'] ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
