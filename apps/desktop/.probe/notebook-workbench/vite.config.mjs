import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFile, realpath } from 'node:fs/promises'
import { extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import buildEditorAssets from '../../../../packages/mica-editor/build.mjs'

const root = fileURLToPath(new URL('.', import.meta.url))
const repo = resolve(root, '../../../..')
const output = resolve(repo, 'temp/notebook-workbench-runtime')
const runtimeRoot = resolve(repo, 'packages/mica-editor/runtime')
const sharedControls = resolve(repo, 'packages/mica-config-ui/web/components')
const arcoStyles = resolve(repo, 'packages/mica-config-ui/web/arco-settings.css')
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}

function isolatedEditorRuntime() {
  let pendingBuild
  let revision = 0
  let builtRevision = -1

  async function ensureBuild() {
    while (builtRevision !== revision) {
      if (!pendingBuild) {
        const buildingRevision = revision
        pendingBuild = buildEditorAssets({ outDir: output })
          .then(() => { builtRevision = buildingRevision })
          .finally(() => { pendingBuild = undefined })
      }
      await pendingBuild
    }
  }

  return {
    name: 'notebook-workbench:isolated-editor-runtime',
    configureServer(server) {
      const invalidate = (_event, file) => {
        const path = resolve(file)
        const parts = relative(runtimeRoot, path).split(sep)
        if (path !== arcoStyles && !path.startsWith(sharedControls + sep) &&
          (!path.startsWith(runtimeRoot + sep) || parts.some((part) => ['node_modules', 'dist', 'coverage', '.vite'].includes(part)))) return
        revision += 1
      }
      server.watcher.add([runtimeRoot, sharedControls, arcoStyles])
      server.watcher.on('all', invalidate)
      server.httpServer?.once('close', () => server.watcher.off('all', invalidate))

      server.middlewares.use(async (req, res, next) => {
        // Keep raw segments: URL() would normalize traversal before validation.
        const pathname = (req.url || '').split(/[?#]/, 1)[0]
        if (pathname !== '/editor' && !pathname.startsWith('/editor/')) return next()
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('X-Content-Type-Options', 'nosniff')
        const fail = (status, message) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end(req.method === 'HEAD' ? undefined : message)
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.setHeader('Allow', 'GET, HEAD')
          return fail(405, 'Method not allowed')
        }
        let parts
        try {
          parts = pathname.slice('/editor/'.length).split('/').map(decodeURIComponent)
        } catch {
          return fail(404, 'Not found')
        }
        if (parts.some((part) => part === '..' || part === '.' || /[/\\\x00-\x1f\x7f]/.test(part))) {
          return fail(404, 'Not found')
        }
        try {
          await ensureBuild()
        } catch (error) {
          server.config.logger.error(String(error.stack || error))
          return fail(500, '编辑器运行时构建失败，请查看探针服务日志。')
        }
        try {
          const outputRoot = await realpath(output)
          const source = await realpath(resolve(outputRoot, parts.join('/') || 'index.html'))
          if (!source.startsWith(outputRoot + sep)) return fail(404, 'Not found')
          const bytes = await readFile(source)
          res.setHeader('Content-Type', types[extname(source).toLowerCase()] || 'application/octet-stream')
          res.setHeader('Content-Length', bytes.byteLength)
          res.end(req.method === 'HEAD' ? undefined : bytes)
        } catch (error) {
          if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return fail(404, 'Not found')
          server.config.logger.error(String(error.stack || error))
          fail(500, '编辑器运行时资源读取失败，请查看探针服务日志。')
        }
      })
    }
  }
}

export default defineConfig({
  root,
  plugins: [react(), tailwindcss(), isolatedEditorRuntime()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@packages': resolve(repo, 'packages'),
      '@mica-config-ui/web': resolve(repo, 'packages/mica-config-ui/web/index.tsx')
    }
  },
  server: { host: '127.0.0.1', port: 5287, strictPort: true, fs: { allow: [repo] } }
})
