import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { applyUiStatePatch, sanitizeUiStateKeys, uiStateChangeSet } from '@packages/mica-web-shared'

/**
 * 页面 UI 状态的唯一事实来源。
 *
 * 桌面端是「单一实例」：界面状态（输入框里还没发出去的草稿、打开的对话页签与文件夹树、
 * 面板宽度/折叠/当前 Tab）不再各自留在浏览器内存里，而是放在运行时进程、落盘到
 * `userData/ui-state.json`、并把变更广播给所有已连接页面。由此得到三个性质：
 * - 第二个窗口/页签不是「另一处」，它渲染的就是同一份状态（工作区里的 node id 因此全局
 *   一致，chat run 的归属不再需要跨页签认领，见 host/chat.js）；
 * - 退出重启后仍是上一次的界面；
 * - 换设备、刷新页面都不必各自保存一份。
 *
 * 取值按扁平键存放（`workspace`、`drafts`、`layout`…），值是可 JSON 化的任意数据。写入是
 * 「整键替换」的 last-write-wins：两个页面同时拖同一根分隔条没有意义，但一个页面改、
 * 另一个页面立刻跟着变是必须的。
 */

const FILE_NAME = 'ui-state.json'
/** 老版本把工作区单独存在这里，首次启动时搬进 ui-state 并停写。 */
const LEGACY_WORKSPACE_FILE = 'workspace.json'
/** 打字/拖动会连续产生补丁，落盘与广播都攒一下再发。 */
const WRITE_DEBOUNCE_MS = 250
const BROADCAST_DEBOUNCE_MS = 80

let keys = null
let writeTimer = null
let broadcastTimer = null
let pendingBroadcast = {}
let send = () => {}

/** 由运行时注入广播（server/index.js 的 SSE broadcast）。 */
export function setUiStateSender(fn) {
  send = typeof fn === 'function' ? fn : () => {}
}

function stateFile() {
  return join(app.getPath('userData'), FILE_NAME)
}

function readJson(file) {
  try {
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function load() {
  if (keys) return keys
  const stored = readJson(stateFile())
  keys = sanitizeUiStateKeys(stored?.keys)
  if (!('workspace' in keys)) {
    const legacy = readJson(join(app.getPath('userData'), LEGACY_WORKSPACE_FILE))
    if (legacy && Array.isArray(legacy.nodes)) keys.workspace = legacy
  }
  return keys
}

function writeNow() {
  try {
    const file = stateFile()
    mkdirSync(dirname(file), { recursive: true })
    // 先写临时文件再改名：进程被强杀时不会留下半截 JSON 让下次启动丢掉全部界面状态。
    const temporary = `${file}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, keys: load() }, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    console.error('[mica-desktop] 保存界面状态失败:', error)
  }
}

function scheduleWrite() {
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    writeNow()
  }, WRITE_DEBOUNCE_MS)
  writeTimer.unref?.()
}

function flushBroadcast() {
  if (broadcastTimer) {
    clearTimeout(broadcastTimer)
    broadcastTimer = null
  }
  const changed = pendingBroadcast
  pendingBroadcast = {}
  if (Object.keys(changed).length === 0) return
  send('ui-state:changed', { keys: changed })
}

function scheduleBroadcast(changed) {
  pendingBroadcast = { ...pendingBroadcast, ...changed }
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    flushBroadcast()
  }, BROADCAST_DEBOUNCE_MS)
  broadcastTimer.unref?.()
}

/** 当前键值表的浅拷贝，直接交给页面（IPC 会做一次 JSON 往返，不需要深拷贝）。 */
export function getUiStateSnapshot() {
  return { ...load() }
}

export function getUiStateKey(key) {
  return load()[key] ?? null
}

/**
 * 合并一份补丁：真正变化的键会落盘并广播给所有页面。返回变化的键（没有变化时为空对象），
 * 调用方可以据此判断是否真的写入了东西。
 */
export function patchUiState(patch) {
  const current = load()
  const next = applyUiStatePatch(current, patch)
  if (!next) return {}
  keys = next
  const changed = uiStateChangeSet(current, next)
  scheduleWrite()
  scheduleBroadcast(changed)
  return changed
}

/** 退出前把攒着的写入与广播一起吐出去（server 关闭时调用）。 */
export function flushUiState() {
  flushBroadcast()
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  if (keys) writeNow()
}

export function registerUiStateIpc() {
  ipcMain.handle('ui-state:get', () => getUiStateSnapshot())
  ipcMain.handle('ui-state:patch', (_event, patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: '界面状态补丁不合法' }
    }
    return { ok: true, changed: patchUiState(patch) }
  })
}
