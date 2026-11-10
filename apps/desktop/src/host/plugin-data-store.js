import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { acquireProcessLock } from '@packages/mica-common/processLock.js'
import {
  decodePluginData,
  encodePluginData,
  isValidPluginDocumentKey,
  pluginDataPath
} from './plugin-data-core.js'

function hasDocumentKey(options) {
  return Object.hasOwn(options ?? {}, 'key')
}

/** 安全 key 也不能借已有符号链接绕出本插件目录；MICA_HOME 本身仍可由用户指定。 */
function assertDocumentPath(file) {
  const documents = dirname(file)
  const plugin = dirname(documents)
  for (const path of [dirname(plugin), plugin, documents, file, `${file}.lock.owners`]) {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error('插件文档路径非法：不能使用符号链接')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

function dataPath(home, pluginId, options) {
  if (hasDocumentKey(options) && !isValidPluginDocumentKey(options.key)) {
    throw new Error('插件文档 key 非法：须为 1–128 位字母数字与 . _ -，以字母数字开头且不能包含 .. 或路径分隔符')
  }
  const file = pluginDataPath(home, pluginId, options)
  if (!file) throw new Error('插件 id 非法：只能是小写字母、数字与 . _ -，不能带路径分隔符')
  if (hasDocumentKey(options)) assertDocumentPath(file)
  return file
}

function readFile(file, options) {
  try {
    const raw = readFileSync(file, 'utf8')
    return {
      value: decodePluginData(raw, { strict: hasDocumentKey(options) }),
      version: createHash('sha256').update(raw).digest('hex')
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { value: null, version: null }
    throw new Error(`读取插件数据失败：${error?.message ?? error}`)
  }
}

/** 版本标记只比较原始文件内容，不解释插件自己的数据结构。 */
export function readPluginData(home, pluginId, options = {}) {
  const file = hasDocumentKey(options)
    ? dataPath(home, pluginId, options)
    : pluginDataPath(home, pluginId)
  return file ? readFile(file, options) : { value: null, version: null }
}

/** 可选的版本比较与原子写入在同一跨进程临界区内完成。 */
export function writePluginData(home, pluginId, value, options = {}) {
  const file = dataPath(home, pluginId, options)
  const encoded = encodePluginData(value, options)
  if (!encoded.ok) throw new Error(encoded.error)
  const release = acquireProcessLock(`${file}.lock`)
  if (!release) return { ok: false, conflict: true, error: '插件数据正在保存，请重试' }
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    // 即使没带 CAS，也不允许把损坏的文档当空白覆盖；旧配置的读取语义保持不变。
    const current =
      hasDocumentKey(options) || Object.hasOwn(options, 'expectedVersion')
        ? readFile(file, options)
        : null
    if (
      Object.hasOwn(options, 'expectedVersion') &&
      current.version !== options.expectedVersion
    ) {
      return { ok: false, conflict: true, error: '插件数据已更新，请重新读取后保存' }
    }
    writeFileSync(temp, `${encoded.json}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
    return { ok: true }
  } catch (error) {
    throw new Error(`写入插件数据失败：${error?.message ?? error}`)
  } finally {
    try {
      rmSync(temp, { force: true })
    } finally {
      release()
    }
  }
}
