import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const runtimeRoot = fileURLToPath(new URL('./runtime/', import.meta.url))
const themeFile = fileURLToPath(new URL('../mica-config-ui/web/arco-settings.css', import.meta.url))
const devRoot = fileURLToPath(new URL('../../temp/editor-web-dev/', import.meta.url))
const runtimeRequire = createRequire(new URL('./runtime/package.json', import.meta.url))
const prefix = '/editor/'
const contentTypes = {
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

/** Build the one isolated runtime with its own pinned development toolchain. */
export default async function buildEditorAssets({ outDir }) {
  const { build } = await import(pathToFileURL(runtimeRequire.resolve('vite')).href)
  await build({
    configFile: resolve(runtimeRoot, 'vite.config.mjs'),
    build: { outDir: resolve(outDir), emptyOutDir: true }
  })
}

/** Both browser hosts serve the same /editor/ assets; no plugin owns this build. */
export function editorWebAssets() {
  let config
  let pendingBuild
  let revision = 0
  let builtRevision = -1
  let stopWatching

  async function ensureDevBuild() {
    // A source change during a build needs a second build, never parallel writers.
    while (builtRevision !== revision) {
      if (!pendingBuild) {
        const buildingRevision = revision
        pendingBuild = buildEditorAssets({ outDir: devRoot })
          .then(() => { builtRevision = buildingRevision })
          .finally(() => { pendingBuild = undefined })
      }
      await pendingBuild
    }
  }

  return {
    name: 'mica:editor-web-assets',
    configResolved(value) { config = value },
    async closeBundle() {
      stopWatching?.()
      if (config.command !== 'build') return
      await buildEditorAssets({ outDir: resolve(config.root, config.build.outDir, 'editor') })
    },
    configureServer(server) {
      const invalidate = (_event, file) => {
        const path = resolve(file)
        const parts = relative(runtimeRoot, path).split(sep)
        if (path !== themeFile && (!path.startsWith(runtimeRoot) || parts.some((part) => ['node_modules', 'dist', 'coverage', '.vite'].includes(part)))) return
        revision += 1
      }
      server.watcher.add([runtimeRoot, themeFile])
      server.watcher.on('all', invalidate)
      stopWatching = () => server.watcher.off('all', invalidate)

      server.middlewares.use(async (req, res, next) => {
        // Keep the raw pathname: URL() normalizes dot segments before validation.
        const pathname = (req.url || '').split(/[?#]/, 1)[0]
        if (pathname !== '/editor' && !pathname.startsWith(prefix)) return next()
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Cache-Control', 'no-store')
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
        try { parts = pathname.slice(prefix.length).split('/').map(decodeURIComponent) } catch { return fail(404, 'Not found') }
        if (parts.some((part) => part === '..' || part === '.' || /[/\\\x00-\x1f\x7f]/.test(part))) return fail(404, 'Not found')
        try {
          await ensureDevBuild()
        } catch (error) {
          server.config.logger.error(String(error.stack || error))
          return fail(500, '编辑器页面构建失败，请检查开发服务日志')
        }
        try {
          const root = await realpath(devRoot)
          const asset = await realpath(resolve(root, parts.join('/') || 'index.html'))
          if (!asset.startsWith(root + sep)) return fail(404, 'Not found')
          const bytes = await readFile(asset)
          res.setHeader('Content-Type', contentTypes[extname(asset).toLowerCase()] || 'application/octet-stream')
          res.setHeader('Content-Length', bytes.byteLength)
          res.end(req.method === 'HEAD' ? undefined : bytes)
        } catch (error) {
          if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return fail(404, 'Not found')
          server.config.logger.error(String(error.stack || error))
          fail(500, '编辑器资源读取失败，请检查开发服务日志')
        }
      })
    }
  }
}
