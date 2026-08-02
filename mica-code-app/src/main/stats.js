import { app, ipcMain } from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'
import { isChatSessionRunning } from './chat'
import {
  dedupeStatsSessions,
  parseStatsSession,
  projectMessages,
  projectSubagentRecords,
  projectUsage
} from './stats-core'

/**
 * mica 的对话 session 快照统计：直接扫描 ~/.mica/sessions/*.json（真实 AI 会话），
 * 聚合出与 code-by-wire 对齐的快照结构（会话数 / turns / tokens / 模型 / 活跃记录 / 每日 / 日历）。
 * 目录内容指纹（文件名+mtime+size）不变时复用内存缓存，避免每次轮询重读 200+ 个大文件。
 */

/** 会话目录：MICA_HOME 环境变量可覆盖，默认 ~/.mica/sessions */
function sessionsDir() {
  const micaHome = process.env.MICA_HOME
  return micaHome ? join(micaHome, 'sessions') : join(app.getPath('home'), '.mica', 'sessions')
}

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
  const file = pinsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/** 侧栏手动拖拽排序：userData/session-sort.json，{ [section]: [sessionId, ...] } */
function sortFile() {
  return join(app.getPath('userData'), 'session-sort.json')
}

function readSort() {
  try {
    const raw = JSON.parse(readFileSync(sortFile(), 'utf8'))
    const sort = {}
    for (const section of ['pinned', 'sessions', 'recent']) {
      const list = raw?.[section]
      sort[section] = Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id) : []
    }
    return sort
  } catch {
    return { pinned: [], sessions: [], recent: [] }
  }
}

function setSectionSort(section, ids) {
  if (!['pinned', 'sessions', 'recent'].includes(section)) return readSort()
  const next = readSort()
  next[section] = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : []
  const file = sortFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

function sessionFile(sessionId) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null
  return join(sessionsDir(), `${sessionId}.json`)
}

/** 目录内容指纹：每个 session 文件的 name:mtimeMs:size，按名字排序拼起来 */
function fingerprint(dir) {
  if (!existsSync(dir)) return ''
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const st = statSync(join(dir, name))
        return `${name}:${st.mtimeMs}:${st.size}`
      })
      .sort()
      .join('|')
  } catch {
    return ''
  }
}

/** 解析单个 session 的轻量元数据（不展开 snapshot，供侧栏/最近列表轮询） */
function parseSessionMeta(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const updatedAtMs = Date.parse(raw.updatedAt)
  if (!Number.isFinite(updatedAtMs)) return null
  const createdAtMs = Date.parse(raw.createdAt)
  return {
    id: raw.id || null,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : null,
    cwd: typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : null,
    updatedAtMs,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
    turnState: raw.turnState || 'completed'
  }
}

/** 扫描全部 session 轻量元数据，按最近更新降序；指纹未变化时复用缓存 */
function scanMeta() {
  const dir = sessionsDir()
  const fp = fingerprint(dir)
  if (metaCache && metaCache.fingerprint === fp) return metaCache.sessions
  const sessions = []
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const row = parseSessionMeta(join(dir, name))
        if (row) sessions.push(row)
      } catch {
        // 单个文件损坏不影响整体
      }
    }
  }
  sessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs)
  metaCache = { fingerprint: fp, sessions }
  return sessions
}

/** 解析单个 session 文件为统计行；损坏/示例文件返回 null */
function parseSession(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  return parseStatsSession(raw)
}

/** 扫描并缓存；指纹未变化时直接返回缓存 */
function scan() {
  const dir = sessionsDir()
  const fp = fingerprint(dir)
  if (cache && cache.fingerprint === fp) return cache.sessions
  const sessions = []
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const row = parseSession(join(dir, name))
        if (row) sessions.push(row)
      } catch {
        // 单个文件损坏不影响整体
      }
    }
  }
  const deduped = dedupeStatsSessions(sessions)
  cache = { fingerprint: fp, sessions: deduped }
  return deduped
}

let cache = null
let metaCache = null

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
  ipcMain.handle('stats:set-pin', (_event, { sessionId, pinned } = {}) =>
    setPin(sessionId, !!pinned)
  )
  ipcMain.handle('stats:list-sort', () => readSort())
  ipcMain.handle('stats:set-sort', (_event, { section, ids } = {}) => setSectionSort(section, ids))
}
