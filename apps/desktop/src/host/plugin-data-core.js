/**
 * 插件自己那份数据的落盘约定（纯逻辑，便于单测）。
 *
 * 配置在 `$MICA_HOME/plugin-data/<pluginId>/data.json`，独立文档在其 `documents/<key>.json`；
 * 内容由插件自己定义——宿主只负责把一份 JSON 原样写进去、原样读回来，
 * **不解析结构、不认识任何具体插件**。插件想在
 * 里面存连接清单、书签还是草稿，宿主一行代码都不用改。
 *
 * 另两份同名文件（`session-annotations.json` 等）由各自的插件按需维护，这个模块只管
 * 通用配置与独立文档。
 */

import { join } from 'node:path'

/** 一份插件数据的上限：够放几千条连接/草稿，又不至于把 `/api/invoke` 撑爆。 */
export const PLUGIN_DATA_MAX_BYTES = 256 * 1024
/** 手机中转的 /api/invoke 上限为 8 MiB；文档留出 RPC 信封余量，不改传输层限制。 */
export const PLUGIN_DOCUMENT_MAX_BYTES = 6 * 1024 * 1024
export const PLUGIN_DATA_FILE = 'data.json'

/** pluginId 会被直接当目录名用，只接受一个安全的标识符。 */
export function isValidPluginId(pluginId) {
  const id = typeof pluginId === 'string' ? pluginId.trim() : ''
  if (!id) return false
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !id.includes('..')
}

/** 文档 key 是一个不含路径的 ASCII 标识符，长度也给临时文件名留出余量。 */
export function isValidPluginDocumentKey(key) {
  return (
    typeof key === 'string' &&
    key.length >= 1 && key.length <= 128 &&
    /^[a-z0-9]/i.test(key) &&
    !/[^a-z0-9._-]/i.test(key) &&
    !key.includes('..')
  )
}

/** 不带 key 读写 data.json，带 key 则定位独立文档；非法标识符返回 null。 */
export function pluginDataPath(home, pluginId, options = {}) {
  if (!isValidPluginId(pluginId)) return null
  const base = typeof home === 'string' ? home.trim() : ''
  if (!base) return null
  if (Object.hasOwn(options ?? {}, 'key')) {
    if (!isValidPluginDocumentKey(options.key)) return null
    return join(base, 'plugin-data', pluginId.trim(), 'documents', `${options.key}.json`)
  }
  return join(base, 'plugin-data', pluginId.trim(), PLUGIN_DATA_FILE)
}

/**
 * 序列化成要落盘的那一段文本。
 *
 * 超过上限或压根序列化不了（BigInt、循环引用）都返回 `{ ok: false, error }` 而不是抛：
 * 这是用户数据，一句可读的原因比一次崩溃有用。
 */
export function encodePluginData(value, options = {}) {
  let json
  try {
    json = JSON.stringify(value)
  } catch (error) {
    return { ok: false, error: `数据无法序列化为 JSON：${error?.message ?? error}` }
  }
  if (typeof json !== 'string') return { ok: false, error: '数据为空，无法写入' }
  const document = Object.hasOwn(options ?? {}, 'key')
  const maxBytes = document ? PLUGIN_DOCUMENT_MAX_BYTES : PLUGIN_DATA_MAX_BYTES
  if (Buffer.byteLength(json, 'utf8') > maxBytes) {
    return {
      ok: false,
      error: document
        ? `插件文档超过 ${maxBytes / (1024 * 1024)} MiB 上限`
        : `插件数据超过 ${Math.round(maxBytes / 1024)} KiB 上限`
    }
  }
  return { ok: true, json }
}

/** 配置保留坏文件返回 null 的约定；文档必须 strict，防止把损坏误认为没有正文。 */
export function decodePluginData(raw, { strict = false } = {}) {
  try {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('文件为空或不是 JSON 文本')
    const parsed = JSON.parse(raw)
    return parsed === undefined ? null : parsed
  } catch (error) {
    if (strict) throw new Error(`插件文档 JSON 损坏：${error?.message ?? error}`)
    return null
  }
}
