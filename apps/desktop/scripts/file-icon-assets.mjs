import { readFile, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const manifestPath = fileURLToPath(
  new URL('../src/renderer/src/vscode-icons-manifest.json', import.meta.url)
)
const iconDir = fileURLToPath(new URL('../src/renderer/assets/file-icons', import.meta.url))
const virtualId = 'virtual:file-icon-assets'
const resolvedVirtualId = `\0${virtualId}`

// FileIcon 的文件、目录、展开和默认图标回退都使用这些名称。清单可以引用不存在的
// 特化图标：只收录实际存在的文件，让组件继续回退到普通目录或默认图标。
function reachableIconNames(manifest) {
  const names = new Set([
    `default_${manifest.defaults.file}`,
    `default_${manifest.defaults.folder}`,
    `default_${manifest.defaults.folder}_opened`
  ])
  for (const name of [
    ...Object.values(manifest.files),
    ...Object.values(manifest.extensions),
    manifest.defaults.file
  ]) {
    names.add(`file_type_${name}`)
  }
  for (const name of [...Object.values(manifest.folders), manifest.defaults.folder]) {
    names.add(`folder_type_${name}`)
    names.add(`folder_type_${name}_opened`)
  }
  return names
}

function urlPath(path) {
  return path
    .split(sep)
    .filter(Boolean)
    .map((part) => (/^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)))
    .join('/')
}

export function fileIconAssets() {
  let config

  return {
    name: 'mica:file-icon-assets',
    configResolved(resolved) {
      config = resolved
    },
    resolveId(id) {
      return id === virtualId ? resolvedVirtualId : null
    },
    async load(id) {
      if (id !== resolvedVirtualId) return null

      this.addWatchFile(manifestPath)
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      const available = new Set(await readdir(iconDir))
      const names = [...reachableIconNames(manifest)]
        .filter((name) => available.has(`${name}.svg`))
        .sort()

      if (config.command === 'serve') {
        // 图标位于 renderer root 时由 Vite 静态服务直接提供；其他 root 使用 /@fs/。
        // 使用 Vite 已规范化的 base 和 origin，兼容子路径与远程 dev server。
        const dirFromRoot = relative(config.root, iconDir)
        const insideRoot =
          dirFromRoot !== '..' && !dirFromRoot.startsWith(`..${sep}`) && !isAbsolute(dirFromRoot)
        const urlDir = insideRoot ? urlPath(dirFromRoot) : `@fs/${urlPath(iconDir)}`
        const base = `${(config.server.origin || '').replace(/\/$/, '')}${config.base}`
        const entries = names.map((name) => [
          name,
          `${base}${urlDir}/${encodeURIComponent(name)}.svg`
        ])
        return `export default ${JSON.stringify(Object.fromEntries(entries))}`
      }

      // 直接发出文件，避免把每个 SVG 当成一个 Vite 模块处理；Vite 的 file URL
      // hook 负责相对 base 和文件 hash，Electron 与移动端静态服务共用同一份产物。
      // 限制同时打开的文件数量，避免在文件描述符上限较低的开发机器上触发 EMFILE。
      const sources = []
      for (let index = 0; index < names.length; index += 64) {
        const batch = names.slice(index, index + 64)
        const batchSources = await Promise.all(
          batch.map(async (name) => {
            const path = join(iconDir, `${name}.svg`)
            this.addWatchFile(path)
            return readFile(path)
          })
        )
        sources.push(...batchSources)
      }
      if (config.build.watch) this.addWatchFile(iconDir)
      const entries = names.map((name, index) => {
        const ref = this.emitFile({ type: 'asset', name: `${name}.svg`, source: sources[index] })
        return `${JSON.stringify(name)}: import.meta.ROLLDOWN_FILE_URL_${ref}`
      })
      return `export default {${entries.join(',')}}`
    },
    configureServer(server) {
      // 直接 URL 没有 SVG 模块依赖；新增、删除或编辑图标后刷新页面并重建映射，
      // 让开发时的回退和资源更新仍然立即生效。清单变更由 addWatchFile 跟踪。
      server.watcher.add(iconDir)
      server.watcher.on('all', (event, file) => {
        if (
          !['add', 'change', 'unlink'].includes(event) ||
          dirname(file).replaceAll('\\', '/') !== iconDir.replaceAll('\\', '/') ||
          !file.endsWith('.svg')
        )
          return
        const module = server.moduleGraph.getModuleById(resolvedVirtualId)
        if (!module) return
        server.moduleGraph.invalidateModule(module)
        server.ws.send({ type: 'full-reload' })
      })
    }
  }
}
