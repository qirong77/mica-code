import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFile, realpath } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import buildEditorAssets from '../../../../packages/mica-editor/build.mjs'

const root = fileURLToPath(new URL('.', import.meta.url))
const repo = resolve(root, '../../../..')
const output = resolve(repo, 'temp/notebook-design-runtime')
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png'
}

// Preview-only decorations. The real Notebook runtime, CDN graph, protocol,
// controls and document data are reused without editing installed assets.
function previewRuntime() {
  let build
  return {
    name: 'notebook-design:isolated-runtime',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url || '').split(/[?#]/, 1)[0]
        if (!path.startsWith('/editor/')) return next()
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { Allow: 'GET, HEAD' }).end()
          return
        }
        try {
          const parts = path.slice('/editor/'.length).split('/').map(decodeURIComponent)
          if (parts.some((part) => part === '..' || part === '.' || /[/\\\x00-\x1f]/.test(part))) {
            res.writeHead(404).end()
            return
          }
          const name = parts.join('/') || 'index.html'
          let source
          if (['design-bridge.js', 'editor-preview.css', 'variants-editor.css'].includes(name)) {
            source = resolve(root, name)
          } else {
            build ??= buildEditorAssets({ outDir: output }).catch((error) => {
              build = undefined
              throw error
            })
            await build
            source = await realpath(resolve(output, name))
            if (!source.startsWith((await realpath(output)) + sep)) {
              res.writeHead(404).end()
              return
            }
          }
          let bytes = await readFile(source)
          if (name === 'index.html') {
            bytes = Buffer.from(
              bytes
                .toString()
                .replace(
                  '</head>',
                  '<link rel="stylesheet" href="./editor-preview.css"><link rel="stylesheet" href="./variants-editor.css"><script src="./design-bridge.js" defer></script></head>'
                )
            )
          }
          res.writeHead(200, {
            'Content-Type': types[extname(source)] || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            'X-Content-Type-Options': 'nosniff'
          })
          res.end(req.method === 'HEAD' ? undefined : bytes)
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes(error.code))
            server.config.logger.error(String(error.stack || error))
          res
            .writeHead(error.code === 'ENOENT' ? 404 : 500)
            .end('编辑器预览暂时无法加载，请查看预览服务日志。')
        }
      })
    }
  }
}

export default defineConfig({
  root,
  plugins: [react(), tailwindcss(), previewRuntime()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@packages': resolve(repo, 'packages'),
      '@mica-config-ui/web': resolve(repo, 'packages/mica-config-ui/web/index.tsx')
    }
  },
  server: { host: '127.0.0.1', port: 5286, strictPort: true, fs: { allow: [repo] } }
})
