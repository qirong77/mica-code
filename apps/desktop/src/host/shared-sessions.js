import { app, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import {
  addSharedSession,
  emptySharedSessions,
  normalizeSharedSessions,
  removeSharedSession
} from './shared-sessions-core'

/**
 * 分享链接登记表的宿主：磁盘上的 `userData/shared-sessions.json` 与 `share:*` 这组 IPC。
 *
 * 数据模型在 shared-sessions-core.js。放在运行时而不是页面里，理由和 loops/ui-state 一样：
 * 页面只是运行时的一个视口，换台设备打开分享端口时列表必须是同一份。
 */

const FILE_NAME = 'shared-sessions.json'

let cache = null

function file() {
  return join(app.getPath('userData'), FILE_NAME)
}

function load() {
  if (cache) return cache
  try {
    const raw = existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : null
    cache = normalizeSharedSessions(raw)
  } catch {
    // 文件损坏时退回空列表：下一次写入会覆盖成合法内容，而不是让运行时起不来。
    cache = emptySharedSessions()
  }
  return cache
}

function persist(next) {
  const normalized = normalizeSharedSessions(next)
  const changed = JSON.stringify(normalized) !== JSON.stringify(cache)
  cache = normalized
  if (changed) {
    try {
      const target = file()
      mkdirSync(dirname(target), { recursive: true })
      // 先写临时文件再改名：进程被强杀时不会留下半截 JSON 让整张列表凭空消失。
      const temporary = `${target}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
      renameSync(temporary, target)
    } catch (error) {
      console.error('[mica-desktop] 保存分享链接列表失败:', error)
    }
  }
  return normalized
}

export function getSharedSessions() {
  return load()
}

export function registerSharedSessionIpc() {
  ipcMain.handle('share:list', () => ({ ok: true, entries: load().entries }))

  ipcMain.handle('share:add', (_event, { sessionId } = {}) => {
    const result = addSharedSession(load(), sessionId)
    if (!result.ok) return { ok: false, error: result.error, entries: load().entries }
    const state = persist(result.state)
    return { ok: true, entries: state.entries }
  })

  ipcMain.handle('share:remove', (_event, { sessionId } = {}) => {
    const result = removeSharedSession(load(), sessionId)
    if (result.ok) persist(result.state)
    return { ok: true, removed: result.ok, entries: load().entries }
  })
}
