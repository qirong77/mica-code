import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { officialPluginManifests } from '@packages/mica-official-plugins/manifests.js'
import { parsePluginManifest } from '@packages/mica-plugin/PluginManifest.js'
import { completionVisibleToRole } from '@packages/mica-plugin/PluginCompletions.js'
import { PLUGIN_STATE_FILE, readDisabledPluginIds } from '@packages/mica-plugin/PluginState.js'

/**
 * 输入框 `/` 列表里插件挂的条目。
 *
 * 两条来源都要读，因为**不能为了列几个名字去启动插件进程**：
 * - 官方插件：清单随包编译进产物（`mica-official-plugins/manifests.js` 只导入 JSON），
 *   直接读，不碰插件实现；
 * - 用户插件：`$MICA_HOME/plugins/<dir>/plugin.json`，只解析 JSON，不导入入口文件。
 *
 * 停用的插件照样跳过（`plugins-state.json` 是用户的选择），声明了角色的按当前会话角色过滤
 * ——与面板、插件 skill 同一条规则。
 *
 * 候选里带 `insert`：选中就是把它插进输入框，`/` 不执行动作。
 */

const MAX_COMPLETIONS = 120

function micaHome() {
  return process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : join(homedir(), '.mica')
}

function sourceOf(pluginId, declaredId) {
  return {
    kind: 'plugin',
    // 运行期 id 带 `user.` 前缀（用户插件与官方插件共用一套名字），标记上只留可读的那半
    label: `插件 ${declaredId}`,
    detail: pluginId
  }
}

function toEntries(manifest, pluginId, role) {
  const entries = []
  for (const completion of manifest.completions ?? []) {
    if (!completionVisibleToRole(completion, role)) continue
    entries.push({
      name: completion.name,
      description: completion.description,
      insert: completion.insert,
      pluginId,
      source: sourceOf(pluginId, manifest.id)
    })
  }
  return entries
}

/** 用户插件目录里的清单；坏清单与停用的一律跳过，不因为一个目录读不出来就让列表变空。 */
function declaredCompletions(role) {
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
    // 运行期 id 与 `FilePluginLoader` 一致：用户插件统一加 `user.` 前缀
    const pluginId = `user.${manifest.id}`
    if (disabled.has(pluginId)) continue
    entries.push(...toEntries(manifest, pluginId, role))
  }
  return entries
}

function officialCompletions(role) {
  const disabled = new Set(readDisabledPluginIds({ path: join(micaHome(), PLUGIN_STATE_FILE) }))
  const entries = []
  for (const manifest of officialPluginManifests) {
    if (disabled.has(manifest.id)) continue
    entries.push(...toEntries(manifest, manifest.id, role))
  }
  return entries
}

/**
 * 合并两条来源并按名字去重。
 *
 * 用户插件在前：同一个名字被官方与用户插件都声明时，先出现的那条胜出——与磁盘 skill 优先
 * 于插件内置 skill 同一口径，用户自己的东西排前面。
 */
export function listPluginCompletions(role = '') {
  const seen = new Set()
  const merged = []
  for (const entry of [...declaredCompletions(role), ...officialCompletions(role)]) {
    if (seen.has(entry.name)) continue
    seen.add(entry.name)
    merged.push(entry)
    if (merged.length >= MAX_COMPLETIONS) break
  }
  return merged
}
