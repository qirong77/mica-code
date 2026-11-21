import { pluginMcpPath, pluginMcpServerName } from '@packages/mica-plugin/PluginMcp.js'
import { readCachedMcpResult } from './mcp-probe.js'

// 由应用运行时发布实际可用的模块；只读清单，不为输入补全初始化插件或建立 MCP 连接。
let readCatalog = () => []

export function setPluginMcpCatalog(read = () => []) {
  readCatalog = read
}

export function buildPluginMcpServers({ origin, role = '', manifests = readCatalog() }) {
  const base = String(origin || '').trim().replace(/\/+$/, '')
  if (!base) return {}
  return Object.fromEntries(
    manifests.filter((manifest) => isMcpEnabledForRole(manifest, role)).map((manifest) => [
      pluginMcpServerName(manifest.id),
      { type: 'http', url: `${base}${pluginMcpPath(manifest.id)}` }
    ])
  )
}

export function pluginMcpCandidates(origin) {
  const manifests = readCatalog()
  // 角色门控的 MCP 由对应 role 介绍，不再重复占用 `/` 快捷列表。
  const candidates = manifests.filter((manifest) => manifest.mcp === true && !hasRoleGate(manifest))
  const servers = buildPluginMcpServers({ origin, manifests: candidates })
  return candidates.flatMap((manifest) => {
    const name = pluginMcpServerName(manifest.id)
    const config = servers[name]
    if (!config) return []
    return [{
      name,
      ...config,
      description: manifest.description,
      tools: (readCachedMcpResult(name, config)?.tools ?? []).slice(0, 50).map((tool) => tool.name),
      // `label` 只写实体名，`mica-plugin:` 前缀由渲染层按 kind 拼（见 chat-completions.js）
      source: { kind: 'plugin', label: manifest.id, detail: manifest.id }
    }]
  })
}

function hasRoleGate(manifest) {
  return Array.isArray(manifest?.mcpRoles) && manifest.mcpRoles.length > 0
}

function isMcpEnabledForRole(manifest, role) {
  if (manifest?.mcp !== true) return false
  if (!hasRoleGate(manifest)) return true
  return typeof role === 'string' && manifest.mcpRoles.includes(role.trim())
}
