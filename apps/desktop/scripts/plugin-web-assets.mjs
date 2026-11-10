import { readdir, readFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const pluginsRoot = fileURLToPath(new URL('../../../plugins/', import.meta.url))
const prefix = '/plugin-web/'

/**
 * 隔离 Web 运行时的通用构建入口。插件只须提供 web-build.mjs，不在宿主登记业务名词。
 * 产物仍属于 renderer 静态资源，由既有 HTTP 服务托管；第三方依赖策略由插件自行决定。
 */
export function pluginWebAssets() {
  let config
  const builds = new Map()
  let devRoot
  async function builders() {
    return (await readdir(pluginsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^[a-z0-9][a-z0-9._-]*$/.test(name))
  }
  async function buildOne(id, root) {
    const script = join(pluginsRoot, id, 'web-build.mjs')
    try { await readFile(script) } catch (error) {
      if (error.code === 'ENOENT') return false
      throw error
    }
    const module = await import(pathToFileURL(script).href)
    const outDir = join(root, id)
    await mkdir(dirname(outDir), { recursive: true })
    await module.default({ outDir })
    return true
  }
  return {
    name: 'mica:plugin-web-assets',
    configResolved(value) { config = value },
    async closeBundle() {
      if (config.command !== 'build') return
      const root = resolve(config.root, config.build.outDir, 'plugin-web')
      for (const id of await builders()) await buildOne(id, root)
    },
    configureServer(server) {
      devRoot = fileURLToPath(new URL('../../../temp/plugin-web-dev/', import.meta.url))
      server.middlewares.use(async (req, res, next) => {
        const path = new URL(req.url, 'http://localhost').pathname
        if (!path.startsWith(prefix)) return next()
        const [, id, ...encodedParts] = path.slice('/plugin-web'.length).split('/')
        let parts
        try { parts = encodedParts.map(decodeURIComponent) } catch { return next() }
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(id || '') || parts.some((part) => part === '..' || part.includes('/') || part.includes('\\'))) return next()
        try {
          if (!builds.has(id)) builds.set(id, buildOne(id, devRoot))
          if (!(await builds.get(id))) return next()
          const asset = resolve(devRoot, id, parts.join('/') || 'index.html')
          if (!asset.startsWith(resolve(devRoot, id) + '/')) return next()
          const bytes = await readFile(asset)
          const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', woff2: 'font/woff2' }
          res.setHeader('Content-Type', types[asset.split('.').pop()] || 'application/octet-stream')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.setHeader('Cache-Control', 'no-store')
          res.end(bytes)
        } catch (error) {
          builds.delete(id)
          if (error.code === 'ENOENT') return next()
          server.config.logger.error(String(error.stack || error))
          res.statusCode = 500
          res.end('插件页面构建失败，请检查开发服务日志')
        }
      })
      server.watcher.on('change', (file) => {
        if (!file.startsWith(pluginsRoot)) return
        const id = file.slice(pluginsRoot.length).split('/')[0]
        if (file.includes('/editor/')) builds.delete(id)
      })
    }
  }
}
