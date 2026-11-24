import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { officialPluginManifests } from '@packages/mica-official-plugins/manifests.js'
import { parsePluginManifest } from '@packages/mica-plugin/PluginManifest.js'
import { uriApiVisibleToRole } from '@packages/mica-plugin/PluginUriApis.js'
import { PLUGIN_STATE_FILE, readDisabledPluginIds } from '@packages/mica-plugin/PluginState.js'

/**
 * 输入框 `/` 列表里的按需 URI 文档。
 *
 * 这里只读官方 / 用户插件清单，不启动插件。URI 可以是完整的 http(s) / file
 * 地址，也可以是当前页面同源的根路径；后者交给渲染层按当前运行时补成完整地址。
 */

const MAX_URI_APIS = 120

function micaHome() {
  return process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : join(homedir(), '.mica')
}

function sourceOf(pluginId, declaredId) {
  return {
    kind: 'plugin',
    label: declaredId,
    detail: pluginId
  }
}

function toEntries(manifest, pluginId, role) {
  return (manifest.uriApis ?? [])
    .filter((entry) => uriApiVisibleToRole(entry, role))
    .map((entry) => ({
      name: entry.name,
      description: entry.description,
      uri: entry.uri,
      pluginId,
      source: sourceOf(pluginId, manifest.id)
    }))
}

function declaredUriApis(role) {
  const pluginsDir = join(micaHome(), 'plugins')
  if (!existsSync(pluginsDir)) return []
  const disabled = new Set(readDisabledPluginIds({ path: join(micaHome(), PLUGIN_STATE_FILE) }))
  let dirs = []
  try {
    dirs = readdirSync(pluginsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return []
  }

  const entries = []
  for (const entry of dirs) {
    const root = join(pluginsDir, entry.name)
    const manifestFile = join(root, 'plugin.json')
    if (!existsSync(manifestFile)) continue
    let manifest
    try {
      const parsed = parsePluginManifest(JSON.parse(readFileSync(manifestFile, 'utf-8')))
      if (!parsed.ok) continue
      manifest = parsed.manifest
    } catch {
      continue
    }
    const pluginId = `user.${manifest.id}`
    if (disabled.has(pluginId)) continue
    entries.push(...toEntries(manifest, pluginId, role))
  }
  return entries
}

function officialUriApis(role) {
  const disabled = new Set(readDisabledPluginIds({ path: join(micaHome(), PLUGIN_STATE_FILE) }))
  return officialPluginManifests
    .filter((manifest) => !disabled.has(manifest.id))
    .flatMap((manifest) => toEntries(manifest, manifest.id, role))
}

/** 合并用户与官方来源；同名时用户插件优先。 */
export function listPluginUriApis(role = '') {
  const seen = new Set()
  const merged = []
  for (const entry of [...declaredUriApis(role), ...officialUriApis(role)]) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    merged.push(entry)
    if (merged.length >= MAX_URI_APIS) break
  }
  return merged
}
