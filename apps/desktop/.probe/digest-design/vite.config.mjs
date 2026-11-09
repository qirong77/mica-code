import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('.', import.meta.url))
const repo = resolve(root, '../../../..')

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@packages': resolve(repo, 'packages'),
      '@mica-config-ui/web': resolve(repo, 'packages/mica-config-ui/web/index.tsx')
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5234,
    strictPort: true,
    fs: { allow: [repo] }
  }
})
