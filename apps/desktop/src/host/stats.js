import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { isChatSessionRunning } from './chat'
import {
  createGroup,
  deleteGroup,
  emptyProjects,
  normalizeProjects,
  renameGroup,
  setAssignment
} from './session-projects'
import { projectMessages, projectSubagentRecords, projectUsage } from './stats-core'
import { createTurnLeaseProbe, isInterruptedSession } from './session-lease'
import { createStatsScanner } from './stats-scanner'

/**
 * mica 的对话 session 快照统计：直接扫描 ~/.mica/sessions/*.json（真实 AI 会话），
 * 聚合出与 code-by-wire 对齐的快照结构（会话数 / turns / tokens / 模型 / 活跃记录 / 每日 / 日历）。
 * 扫描器按文件完整 stat 签名增量缓存，避免单个文件变化时重读 200+ 个大文件。
 */

/** 会话目录：MICA_HOME 环境变量可覆盖，默认 ~/.mica/sessions */
function sessionsDir() {
  const micaHome = process.env.MICA_HOME
  return micaHome ? join(micaHome, 'sessions') : join(app.getPath('home'), '.mica', 'sessions')
}

const statsScanner = createStatsScanner({ directory: sessionsDir })

const hasLiveTurnLease = createTurnLeaseProbe({
  lockDir: () => join(sessionsDir(), '.turn-locks')
})

let metaInterrupted = { rows: null, key: '', value: null }

function sessionTitle(sessionId) {
  const file = sessionFile(sessionId)
  if (!file) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : null
  } catch {
    return null
  }
}

function renameSession(sessionId, title) {
  if (isChatSessionRunning(sessionId)) {
    throw new Error('Cannot rename a session while its Chat turn is running')
  }
  const file = sessionFile(sessionId)
  const nextTitle = typeof title === 'string' ? title.trim() : ''
  if (!file || !nextTitle) throw new Error('Invalid session title')

  let session
  try {
    session = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error('Session not found')
  }
  if (!session || typeof session !== 'object' || session.id !== sessionId)
    throw new Error('Invalid session')

  const updated = {
    ...session,
    title: nextTitle,
    titleSource: 'manual',
    revision: (Number.isInteger(session.revision) ? session.revision : 0) + 1,
    updatedAt: new Date().toISOString()
  }
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return updated.title
}

/** 置顶会话存储：userData/session-pins.json，{ [sessionId]: pinnedAtMs } */
function pinsFile() {
  return join(app.getPath('userData'), 'session-pins.json')
}

function readPins() {
  try {
    const raw = JSON.parse(readFileSync(pinsFile(), 'utf8'))
    const pins = {}
    for (const [key, value] of Object.entries(raw || {}))
      if (typeof value === 'number' && Number.isFinite(value)) pins[key] = value
    return pins
  } catch {
    return {}
  }
}

function setPin(sessionId, pinned) {
  if (typeof sessionId !== 'string' || !sessionId) return readPins()
  const next = readPins()
  if (pinned) next[sessionId] = Date.now()
  else delete next[sessionId]
  writeJson(pinsFile(), next)
  return next
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** Projects 分区存储：userData/session-projects.json（可嵌套分组 + 会话归属）。 */
function projectsFile() {
  return join(app.getPath('userData'), 'session-projects.json')
}

function readProjects() {
  try {
    return normalizeProjects(JSON.parse(readFileSync(projectsFile(), 'utf8')))
  } catch {
    return emptyProjects()
  }
}

function writeProjects(projects) {
  const normalized = normalizeProjects(projects)
  writeJson(projectsFile(), normalized)
  return normalized
}

/**
 * 侧栏唯一一次「换位置」：pinned / projects / recent 三选一。
 *
 * 一次调用同时落盘 pins 与 projects，两个分区不会短暂地同时列着同一个会话。
 */
function moveSession({ sessionId, section, groupId } = {}) {
  if (typeof sessionId !== 'string' || !sessionId) {
    return { pins: readPins(), projects: readProjects() }
  }
  const pinned = section === 'pinned'
  const target = section === 'project' ? groupId : null
  const projects = writeProjects(setAssignment(readProjects(), sessionId, target))
  return { pins: setPin(sessionId, pinned), projects }
}

/** 侧栏手动拖拽排序：userData/session-sort.json，{ [section]: [sessionId, ...] } */
function sortFile() {
  return join(app.getPath('userData'), 'session-sort.json')
}

function validSection(section) {
  if (section === 'pinned' || section === 'sessions' || section === 'recent') return true
  // 分组内顺序按 `project:<groupId>` 单独存一份，分组删除后遗留的条目无害
  return typeof section === 'string' && /^project:[^:]+$/.test(section)
}

function readSort() {
  try {
    const raw = JSON.parse(readFileSync(sortFile(), 'utf8'))
    const sort = {}
    for (const section of ['pinned', 'sessions', 'recent']) {
      const list = raw?.[section]
      sort[section] = Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id) : []
    }
    for (const [section, list] of Object.entries(raw || {})) {
      if (!section.startsWith('project:')) continue
      sort[section] = Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id) : []
    }
    return sort
  } catch {
    return { pinned: [], sessions: [], recent: [] }
  }
}

function setSectionSort(section, ids) {
  if (!validSection(section)) return readSort()
  const next = readSort()
  next[section] = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : []
  writeJson(sortFile(), next)
  return next
}

function sessionFile(sessionId) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null
  return join(sessionsDir(), `${sessionId}.json`)
}

/**
 * 扫描全部 session 轻量元数据，按最近更新降序。`interrupted` 标记按次探测（见
 * isInterruptedSession：turn lease 的存活判定不能进扫描器的文件签名缓存，持有者可能
 * 在文件没变的情况下消失），但结果不变时要把数组与行对象的引用原样交回去——侧栏用
 * 引用相等来判断是否需要重渲染，每次 refresh 都换新数组会让它白刷一遍。
 */
function scanMeta() {
  const rows = statsScanner.scanMeta()
  const ids = []
  for (const row of rows) if (isInterruptedSession(row, hasLiveTurnLease)) ids.push(row.id)
  const key = ids.join(',')
  if (metaInterrupted.key === key && metaInterrupted.rows === rows) return metaInterrupted.value
  const interrupted = new Set(ids)
  const value = ids.length
    ? rows.map((row) => (interrupted.has(row.id) ? { ...row, interrupted: true } : row))
    : rows
  metaInterrupted = { rows, key, value }
  return value
}

/** 扫描全部 session 统计，并由 stats-core 过滤、去重。 */
function scan() {
  return statsScanner.scanStats()
}

export function registerStatsIpc() {
  ipcMain.handle('stats:read', () => ({
    sessions: scan(),
    scannedAt: Date.now()
  }))
  ipcMain.handle('stats:session-detail', (_event, { sessionId } = {}) => {
    const file = sessionFile(sessionId)
    if (!file || !existsSync(file)) throw new Error('Session not found')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const snap = raw.snapshot || {}
    return {
      id: raw.id || null,
      title: raw.title || null,
      cwd: raw.cwd || null,
      createdAt: raw.createdAt || null,
      updatedAt: raw.updatedAt || null,
      turnState: raw.turnState || 'completed',
      providerId: snap.providerId || null,
      model: snap.model || null,
      effort: snap.effort || null,
      role: snap.role || null,
      contextWindowSize: snap.contextWindowSize || null,
      messages: projectMessages(Array.isArray(snap.messages) ? snap.messages : []),
      usageHistory: (Array.isArray(snap.usageHistory) ? snap.usageHistory : []).map(projectUsage),
      lastUsage: snap.lastUsage ? projectUsage(snap.lastUsage) : null,
      subagentUsageHistory: projectSubagentRecords(
        Array.isArray(snap.subagentUsageHistory) ? snap.subagentUsageHistory : []
      )
    }
  })
  ipcMain.handle('stats:list-sessions', () => ({ sessions: scanMeta() }))
  ipcMain.handle('stats:session-title', (_event, { sessionId } = {}) => sessionTitle(sessionId))
  ipcMain.handle('stats:rename-session', (_event, { sessionId, title } = {}) =>
    renameSession(sessionId, title)
  )
  ipcMain.handle('stats:list-pins', () => readPins())
  ipcMain.handle('stats:move-session', (_event, payload = {}) => moveSession(payload))
  ipcMain.handle('stats:list-sort', () => readSort())
  ipcMain.handle('stats:set-sort', (_event, { section, ids } = {}) => setSectionSort(section, ids))
  ipcMain.handle('stats:list-projects', () => readProjects())
  ipcMain.handle('stats:create-project-group', (_event, { name, parentId } = {}) =>
    writeProjects(
      createGroup(readProjects(), { id: randomUUID(), name, parentId, now: Date.now() })
    )
  )
  ipcMain.handle('stats:rename-project-group', (_event, { groupId, name } = {}) =>
    writeProjects(renameGroup(readProjects(), groupId, name))
  )
  ipcMain.handle('stats:delete-project-group', (_event, { groupId } = {}) =>
    writeProjects(deleteGroup(readProjects(), groupId))
  )
}
