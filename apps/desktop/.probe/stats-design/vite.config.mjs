import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const repo = path.resolve(import.meta.dirname, '../../../..')
const desktopRequire = createRequire(path.join(repo, 'apps/desktop/package.json'))
const [{ defineConfig }, { default: react }, { default: tailwindcss }] = await Promise.all(
  ['vite', '@vitejs/plugin-react', '@tailwindcss/vite'].map((id) =>
    import(pathToFileURL(desktopRequire.resolve(id)).href)
  )
)

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@mica-config-ui/web': path.join(repo, 'packages/mica-config-ui/web/index.tsx'),
      '@packages': path.join(repo, 'packages')
    },
    dedupe: ['react', 'react-dom']
  },
  server: {
    host: '127.0.0.1',
    port: 5233,
    strictPort: true,
    fs: { allow: [repo] }
  }
})
