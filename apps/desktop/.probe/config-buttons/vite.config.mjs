import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: { '@packages': resolve(import.meta.dirname, '../../../../packages') },
  },
  server: { host: '127.0.0.1', port: 5235, strictPort: true },
})
