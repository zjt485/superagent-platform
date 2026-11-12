import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The console is served by the API process from `server/public` in production.
// In development Vite proxies /v1 and /webhooks to the local API on :3000.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': 'http://127.0.0.1:3000',
      '/webhooks': 'http://127.0.0.1:3000',
      '/healthz': 'http://127.0.0.1:3000',
    },
  },
})
