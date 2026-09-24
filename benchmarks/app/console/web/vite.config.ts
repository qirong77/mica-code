import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The backend is the console control plane (python, stdlib only).  In dev we
// proxy /api to it so the page and the API share an origin and there is no CORS
// story; in production the same python server serves ../web/dist directly.
const API_TARGET = process.env.MICA_BENCH_API ?? 'http://127.0.0.1:8790'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5310,
    strictPort: false,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // electron-vite taught the lesson that a default here can silently ship a
    // multi-megabyte unminified bundle; be explicit.
    minify: true,
  },
})
