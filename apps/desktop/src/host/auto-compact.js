import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  applyAutoCompactStatus,
  emptyAutoCompactState,
  normalizeAutoCompactSettings,
  normalizeAutoCompactState,
  readAutoCompactTurnParams as turnParamsFor,
  resetAutoCompactCounters
} from './auto-compact-state'

/**
 * 自动压缩的宿主：磁盘上的 `userData/auto-compact.json`、进程内缓存，以及 `auto-compact:*`
 * 这组 IPC。
 *
 * 与定时循环（loops.js）同一套边界：设置与按会话计的运行次数活在运行时进程里，页面只是
 * 读写视图，所以第二个窗口、刷新、换设备打开看到的都是同一份。chat.js 每次 `turn/start` 从
 * 这里同步取参数（同步是必须的：它就在发请求的那一行），app-server 压完一次回推
 * `mica/autoCompact/updated`，计数记回这里再由页面读取——页面不从这个事件流里攒计数，
 * 它描述的是设置状态而不是一个 turn 的增量。
 *
 * 数据模型与校验在 auto-compact-state.js：这里只管落盘、缓存与 IPC。
 */

const FILE_NAME = 'auto-compact.json'

let broadcast = () => {}
let cache = null

/** 由 server 注入：把设置/计数的变更推给所有页面（等价于 loops:changed 的广播）。 */
export function setAutoCompactBroadcaster(fn) {
  broadcast = typeof fn === 'function' ? fn : () => {}
}

function file() {
  return join(app.getPath('userData'), FILE_NAME)
}

function load() {
  if (cache) return cache
  try {
    const raw = existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : null
    cache = normalizeAutoCompactState(raw)
  } catch {
    // 文件损坏时退回空状态：下一次写入会覆盖成合法内容，而不是让运行时起不来。
    cache = emptyAutoCompactState()
  }
  return cache
}

function persist(next, reason = 'change') {
  const normalized = normalizeAutoCompactState(next)
  const changed = JSON.stringify(normalized) !== JSON.stringify(cache)
  cache = normalized
  // 只有真的变了才写盘/广播：计数每压一次推一次，值没变时不该让所有页面白刷一遍。
  if (changed) {
    try {
      const target = file()
      mkdirSync(dirname(target), { recursive: true })
      // 先写临时文件再改名：进程被强杀时不会留下半截 JSON 让设置与计数凭空消失。
      const temporary = `${target}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
      renameSync(temporary, target)
    } catch (error) {
      console.error('[mica-desktop] 保存自动压缩设置失败:', error)
    }
    broadcast('auto-compact:changed', {
      reason,
      settings: normalized.settings,
      counters: normalized.counters
    })
  }
  return normalized
}

export function getAutoCompactSnapshot() {
  const state = load()
  return { settings: state.settings, counters: state.counters }
}

/** `turn/start` 的扩展参数：chat.js 在发请求前同步取一次（草稿会话还没有 sessionId 时给全零）。 */
export function readAutoCompactTurnParams(sessionId) {
  return turnParamsFor(load(), sessionId)
}

/**
 * app-server 回推一次压缩结果：计数整块按 host 的说法落盘。压缩的执行者与计数的主人都是
 * host 自己（它按 provider 迭代边界决策），这里照单全收而不是本地累加，两边才不会各算一份。
 */
export function recordAutoCompactStatus(sessionId, status) {
  if (!sessionId) return
  const before = load()
  const after = applyAutoCompactStatus(before, sessionId, status)
  if (after !== before) persist(after, 'ran')
}

export function registerAutoCompactIpc() {
  // 计数整张表都回给页面（它按自己的 sessionId 取一份），所以这里不需要请求里的 sessionId
  ipcMain.handle('auto-compact:get', () => ({ ok: true, ...getAutoCompactSnapshot() }))

  ipcMain.handle('auto-compact:set', (_event, { settings } = {}) => {
    const next = persist({ ...load(), settings: normalizeAutoCompactSettings(settings) }, 'settings')
    return { ok: true, settings: next.settings }
  })

  ipcMain.handle('auto-compact:reset-counters', (_event, { sessionId } = {}) => {
    if (!sessionId) return { ok: false, error: 'sessionId 缺失' }
    const before = load()
    const after = resetAutoCompactCounters(before, sessionId)
    if (after !== before) persist(after, 'reset')
    return { ok: true, ...getAutoCompactSnapshot() }
  })
}
