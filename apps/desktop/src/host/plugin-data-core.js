/**
 * 插件自己那份数据的落盘约定（纯逻辑，便于单测）。
 *
 * 位置固定 `$MICA_HOME/plugin-data/<pluginId>/data.json`，内容由插件自己定义——宿主只
 * 负责把一份 JSON 原样写进去、原样读回来，**不解析结构、不认识任何具体插件**。插件想在
 * 里面存连接清单、书签还是草稿，宿主一行代码都不用改。
 *
 * 另两份同名文件（`session-annotations.json` 等）由各自的插件按需维护，这个模块只管
 * `data.json` 这一份通用数据。
 */

import { join } from 'node:path'

/** 一份插件数据的上限：够放几千条连接/草稿，又不至于把 `/api/invoke` 撑爆。 */
export const PLUGIN_DATA_MAX_BYTES = 256 * 1024
export const PLUGIN_DATA_FILE = 'data.json'

/** pluginId 会被直接当目录名用，只接受一个安全的标识符。 */
export function isValidPluginId(pluginId) {
  const id = typeof pluginId === 'string' ? pluginId.trim() : ''
  if (!id) return false
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !id.includes('..')
}

/** `$MICA_HOME/plugin-data/<pluginId>/data.json`；pluginId 非法时返回 null。 */
export function pluginDataPath(home, pluginId) {
  if (!isValidPluginId(pluginId)) return null
  const base = typeof home === 'string' ? home.trim() : ''
  if (!base) return null
  return join(base, 'plugin-data', pluginId.trim(), PLUGIN_DATA_FILE)
}

/**
 * 序列化成要落盘的那一段文本。
 *
 * 超过上限或压根序列化不了（BigInt、循环引用）都返回 `{ ok: false, error }` 而不是抛：
 * 这是用户数据，一句可读的原因比一次崩溃有用。
 */
export function encodePluginData(value) {
  let json
  try {
    json = JSON.stringify(value)
  } catch (error) {
    return { ok: false, error: `数据无法序列化为 JSON：${error?.message ?? error}` }
  }
  if (typeof json !== 'string') return { ok: false, error: '数据为空，无法写入' }
  if (Buffer.byteLength(json, 'utf8') > PLUGIN_DATA_MAX_BYTES) {
    return {
      ok: false,
      error: `插件数据超过 ${Math.round(PLUGIN_DATA_MAX_BYTES / 1024)} KiB 上限`
    }
  }
  return { ok: true, json }
}

/** 读回一份数据；坏 JSON、非字符串、空文件一律 null——坏文件不该让页面崩掉。 */
export function decodePluginData(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed === undefined ? null : parsed
  } catch {
    return null
  }
}
