import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { acquireProcessLock } from '@packages/mica-common/processLock.js'
import { decodePluginData, encodePluginData, pluginDataPath } from './plugin-data-core.js'

function dataPath(home, pluginId) {
  const file = pluginDataPath(home, pluginId)
  if (!file) throw new Error('插件 id 非法：只能是小写字母、数字与 . _ -，不能带路径分隔符')
  return file
}

function readFile(file) {
  try {
    const raw = readFileSync(file, 'utf8')
    return {
      value: decodePluginData(raw),
      version: createHash('sha256').update(raw).digest('hex')
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { value: null, version: null }
    throw new Error(`读取插件数据失败：${error?.message ?? error}`)
  }
}

/** 版本标记只比较原始文件内容，不解释插件自己的数据结构。 */
export function readPluginData(home, pluginId) {
  const file = pluginDataPath(home, pluginId)
  return file ? readFile(file) : { value: null, version: null }
}

/** 可选的版本比较与原子写入在同一跨进程临界区内完成。 */
export function writePluginData(home, pluginId, value, options = {}) {
  const file = dataPath(home, pluginId)
  const encoded = encodePluginData(value)
  if (!encoded.ok) throw new Error(encoded.error)
  const release = acquireProcessLock(`${file}.lock`)
  if (!release) return { ok: false, conflict: true, error: '插件数据正在保存，请重试' }
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    if (
      Object.hasOwn(options, 'expectedVersion') &&
      readFile(file).version !== options.expectedVersion
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
