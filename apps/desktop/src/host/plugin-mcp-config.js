import { pluginMcpPath, pluginMcpServerName } from '@packages/mica-plugin/PluginMcp.js'
import { readCachedMcpResult } from './mcp-probe.js'

// 由应用运行时发布实际可用的模块；只读清单，不为输入补全初始化插件或建立 MCP 连接。
let readCatalog = () => []

export function setPluginMcpCatalog(read = () => []) {
  readCatalog = read
}

export function buildPluginMcpServers({ origin, manifests = readCatalog() }) {
  const base = String(origin || '').trim().replace(/\/+$/, '')
  if (!base) return {}
  return Object.fromEntries(
    manifests.filter((manifest) => manifest.mcp === true).map((manifest) => [
      pluginMcpServerName(manifest.id),
      { type: 'http', url: `${base}${pluginMcpPath(manifest.id)}` }
    ])
  )
}

export function pluginMcpCandidates(origin) {
  const manifests = readCatalog()
  const servers = buildPluginMcpServers({ origin, manifests })
  return manifests.flatMap((manifest) => {
    const name = pluginMcpServerName(manifest.id)
    const config = servers[name]
    if (!config) return []
    return [{
      name,
      ...config,
      description: manifest.description,
      tools: (readCachedMcpResult(name, config)?.tools ?? []).slice(0, 50).map((tool) => tool.name),
      source: { kind: 'plugin', label: `插件 ${manifest.id}`, detail: manifest.id }
    }]
  })
}
