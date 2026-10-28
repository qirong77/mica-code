import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ipcMain } from 'electron'
import { resolveMicaHome } from '@packages/mica-config/index.js'
import { probeRuntime } from './runtime-probe-core'
import { decodePluginData, encodePluginData, pluginDataPath } from './plugin-data-core'
import { applyRemoteAccessPatch, describeRemoteAccess } from './remote-access.js'

/**
 * 插件在桌面端的**能力面**（宿主只提供能力，不认识任何具体插件）。
 *
 * 插件的前端模块跑在页面里，有两件事自己做不到，只能请运行时代劳：
 *
 * - `plugin-host:probe`：探活某个地址上是不是一台 Mica Code 运行时。页面跨源
 *   `fetch('http://other:8787/api/health')` 受 CORS 限制读不到结果，所以由运行时去问。
 * - `plugin-host:read-data` / `plugin-host:write-data`：读写插件自己的那份数据文件
 *   （`$MICA_HOME/plugin-data/<pluginId>/data.json`）。页面没有文件系统，插件的清单、
 *   连接、草稿都只能落在这里；内容由插件自己定义，宿主不解析、不改写。
 * - `plugin-host:access-get` / `plugin-host:access-set`：运行时的**远程访问策略**（是否
 *   要求口令、口令是什么）。这是宿主自己的能力，不属于某个插件——任何要解释或调整「别的
 *   机器怎么进这台机器」的插件都读同一份，宿主的请求分派也读同一份。
 *
 * 判断逻辑分别在 runtime-probe-core.js 与 plugin-data-core.js（纯函数，便于单测）。
 */

function micaHome() {
  return process.env.MICA_HOME || resolveMicaHome()
}

function dataPathOf(pluginId) {
  const file = pluginDataPath(micaHome(), pluginId)
  if (!file) throw new Error('插件 id 非法：只能是小写字母、数字与 . _ -，不能带路径分隔符')
  return file
}

/**
 * 读一份插件数据：pluginId 非法、文件不存在、读不出来或内容坏掉都返回 null——
 * 读不出东西不是错误，插件把 null 当成「还没有数据」。
 */
function readPluginData(pluginId) {
  const file = pluginDataPath(micaHome(), pluginId)
  if (!file) return null
  try {
    return decodePluginData(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 写临时文件再 rename：插件与宿主可能同时读，不能让它读到半份 JSON，
 * 也不能因为写到一半失败就把原文件弄没了。
 */
function writePluginData(pluginId, value) {
  const file = dataPathOf(pluginId)
  const encoded = encodePluginData(value)
  if (!encoded.ok) throw new Error(encoded.error)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  try {
    writeFileSync(temp, `${encoded.json}\n`, 'utf8')
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw new Error(`写入插件数据失败：${error?.message ?? error}`)
  }
}

export function registerPluginHostIpc() {
  ipcMain.handle('plugin-host:probe', (_event, payload) => probeRuntime(payload?.address))

  ipcMain.handle('plugin-host:read-data', (_event, payload) => ({
    value: readPluginData(payload?.pluginId)
  }))

  // 失败直接抛：`POST /api/invoke` 会把 Error 的 message 变成 `{ ok: false, error }`。
  ipcMain.handle('plugin-host:write-data', (_event, payload) => {
    writePluginData(payload?.pluginId, payload?.value)
    return { ok: true }
  })

  /**
   * 运行时自己的远程访问策略。口令会原样回给页面：它要显示「别人该输什么」，而能调到这里
   * 的页面要么在本机、要么已经过了这道口令（远程未过门时 `/api/invoke` 会被 401）。
   */
  ipcMain.handle('plugin-host:access-get', () => describeRemoteAccess())

  ipcMain.handle('plugin-host:access-set', (_event, payload) => {
    const written = applyRemoteAccessPatch(payload)
    return { enabled: written.enabled, password: written.password }
  })
}
