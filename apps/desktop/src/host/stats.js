import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { isChatSessionRunning } from './chat'
import {
  createGroup,
  deleteGroup,
  emptyProjects,
  moveGroup,
  normalizeProjects,
  renameGroup,
  setAssignment
} from './session-projects'
import {
  filterOwnedSubagentRecords,
  filterOwnedUsage,
  ownedUsageIdentities,
  projectMessages,
  projectSubagentRecords,
  projectUsage,
  resolveStaleRequestInput,
  summarizeContext
} from './stats-core'
import { createTurnLeaseProbe, isInterruptedSession } from './session-lease'
import { createStatsScanner } from './stats-scanner'
import { deleteSessionFiles, isValidSessionId, stripSessionFromSort } from './session-delete'

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
  return writeSort(next)
}

function writeSort(sort) {
  writeJson(sortFile(), sort)
  return sort
}

function sessionFile(sessionId) {
  if (typeof sessionId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null
  return join(sessionsDir(), `${sessionId}.json`)
}

/**
 * 快照里的 displayUsage（compact 之后写入的「展示用上下文占用」）。
 * 与 packages/mica-session 的 normalizeDisplayUsage 同口径：缺 totalTokens 或
 * compactedAt 时当作没有，避免用半个记录去判定 lastUsage 是否已作废。
 */
function normalizeDisplayUsage(value) {
  if (!value || typeof value !== 'object') return null
  const totalTokens = Number(value.totalTokens)
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return null
  if (typeof value.compactedAt !== 'string' || !value.compactedAt.trim()) return null
  return { totalTokens, compactedAt: value.compactedAt }
}

/**
 * 本会话出现过的最小请求 input：固定开销（system prompt + AGENT.md + skills 索引 +
 * 全部工具 schema）的上界——它同时还含那次请求已有的历史，所以只会偏高。
 * 差额一旦超过它，就不可能全是固定开销，弹窗要改用「其它差额」的说法。
 */
function minRequestInputTokens(snap) {
  const history = Array.isArray(snap?.usageHistory) ? snap.usageHistory : []
  let min = 0
  for (const event of history) {
    const input = Number(event?.inputTokens)
    if (!Number.isFinite(input) || input <= 0) continue
    if (min === 0 || input < min) min = input
  }
  return min
}

/** turn lease 目录：正在跑的 turn 在这里留下持有者 pid（见 session-lease.js）。 */
function turnLocksDir() {
  return join(sessionsDir(), '.turn-locks')
}

/**
 * 删除一个会话：磁盘上的会话文件、它的 turn lease 锁，以及宿主的侧栏元数据（置顶 /
 * 项目归属 / 手动排序）。会话文件不存在也继续清理元数据，好让悬空条目收敛掉。
 *
 * 正在跑的 turn 一律拒绝：本进程的 Chat turn 由 `isChatSessionRunning` 拦，另一个终端里
 * 跑同一个会话的 TUI 由 turn lease 的持有者存活判定拦——这两种情况下删文件都会让那一轮
 * 的落盘把它重新写回来。
 */
function deleteSession(sessionId) {
  if (!isValidSessionId(sessionId)) throw new Error('Invalid session id')
  if (isChatSessionRunning(sessionId) || hasLiveTurnLease(sessionId))
    throw new Error('Cannot delete a session while its turn is running')
  deleteSessionFiles({ directory: sessionsDir(), lockDir: turnLocksDir(), sessionId })
  return {
    pins: setPin(sessionId, false),
    projects: writeProjects(setAssignment(readProjects(), sessionId, null)),
    sort: writeSort(stripSessionFromSort(readSort(), sessionId))
  }
}

/**
 * 扫描全部 session 轻量元数据，按最近更新降序。`interrupted` / `remoteRunning` 标记
 * 按次探测（见 isInterruptedSession：turn lease 的存活判定不能进扫描器的文件签名缓存，
 * 持有者可能在文件没变的情况下消失），但结果不变时要把数组与行对象的引用原样交回去——
 * 侧栏用引用相等来判断是否需要重渲染，每次 refresh 都换新数组会让它白刷一遍。
 */
function scanMeta() {
  const rows = statsScanner.scanMeta()
  // `interrupted`（running 但没人持锁 = 崩溃残留）与 `remoteRunning`（有活租约 =
  // 某个进程正在写这个会话，可能是另一个窗口/另一个运行时实例）是同一次探测的两种
  // 结论，所以每个会话只读一次锁文件，两个标记也一起进缓存键。
  const probes = new Map()
  const probe = (id) => {
    if (!probes.has(id)) probes.set(id, hasLiveTurnLease(id))
    return probes.get(id)
  }
  const ids = []
  const runningIds = []
  for (const row of rows) {
    if (isInterruptedSession(row, probe)) ids.push(row.id)
    else if (row.turnState === 'running') runningIds.push(row.id)
  }
  const key = `${ids.join(',')}|${runningIds.join(',')}`
  if (metaInterrupted.key === key && metaInterrupted.rows === rows) return metaInterrupted.value
  const interrupted = new Set(ids)
  const running = new Set(runningIds)
  const value =
    ids.length || runningIds.length
      ? rows.map((row) => {
          if (interrupted.has(row.id)) return { ...row, interrupted: true }
          if (running.has(row.id)) return { ...row, remoteRunning: true }
          return row
        })
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
    const messages = Array.isArray(snap.messages) ? snap.messages : []
    const usageHistory = Array.isArray(snap.usageHistory) ? snap.usageHistory : []
    const subagentRecords = Array.isArray(snap.subagentUsageHistory)
      ? snap.subagentUsageHistory.filter((record) => record && typeof record === 'object')
      : []
    // 列表与详情必须共用同一个归属口径（见 ownedUsageIdentities）。scan() 用的是带缓存
    // 的增量扫描，打开详情不会重新读一遍所有会话文件。
    const owned = ownedUsageIdentities(scan(), sessionId)
    const lastUsage = snap.lastUsage ? projectUsage(snap.lastUsage) : null
    const displayUsage = normalizeDisplayUsage(snap.displayUsage)
    // compact / prune 改写过这份历史：lastUsage.inputTokens 描述的是改写**之前**的
    // 上下文，拿它当分母/被减数会把「被清掉的内容」显示成 system prompt / 工具 schema。
    const staleInput = resolveStaleRequestInput({
      // 原始记录（不是投影后的）：判定要用 messageCount，投影会把它丢掉。
      lastUsage: snap.lastUsage,
      displayUsage,
      messageCount: messages.length
    })
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
      messages: projectMessages(messages),
      // 弹窗的「谁占了 context」分解，按原始消息体积估算（与 CLI 的 chars/4 同口径）。
      context: summarizeContext(messages, {
        lastInputTokens: staleInput ? 0 : lastUsage?.inputTokens || 0,
        staleInput,
        fixedOverheadTokens: minRequestInputTokens(snap),
        contextWindowSize: snap.contextWindowSize || null
      }),
      displayUsage,
      // 与列表同一个归属口径：fork 之前写入的会话文件里带着来源会话的用量副本，那些
      // 记录归来源会话，详情视图不能把它们展示成自己的（否则列表 0 请求、详情 106 条）。
      usageHistory: filterOwnedUsage(usageHistory, owned).map(projectUsage),
      lastUsage,
      subagentUsageHistory: projectSubagentRecords(
        filterOwnedSubagentRecords(subagentRecords, owned)
      )
    }
  })
  ipcMain.handle('stats:list-sessions', () => ({ sessions: scanMeta() }))
  ipcMain.handle('stats:session-title', (_event, { sessionId } = {}) => sessionTitle(sessionId))
  ipcMain.handle('stats:rename-session', (_event, { sessionId, title } = {}) =>
    renameSession(sessionId, title)
  )
  ipcMain.handle('stats:delete-session', (_event, { sessionId } = {}) => deleteSession(sessionId))
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
  ipcMain.handle('stats:move-project-group', (_event, { groupId, parentId } = {}) =>
    writeProjects(moveGroup(readProjects(), groupId, parentId))
  )
  ipcMain.handle('stats:delete-project-group', (_event, { groupId } = {}) =>
    writeProjects(deleteGroup(readProjects(), groupId))
  )
}
