/**
 * 侧栏「定时任务」分区的本地模型：一条任务 = 「每隔 N 分钟往某个会话发一次这条消息，共 M 次」。
 *
 * 和 Projects 一样，这里只放纯逻辑（清洗 / 创建 / 计数 / 到期挑选），落盘与定时器在
 * scheduled-runner.js。任务是**会话级**的：至少记 sessionId，这样页面关掉、换设备打开后
 * 它还能继续跑到次数用尽；nodeId 只用来在当前工作区里认领已经打开的页签（能实时看输出、
 * 也能中断），认领不到就用 `scheduled:<id>` 起一个独立 run。
 */
export const SCHEDULED_VERSION = 1

/** 默认间隔（分钟）与默认次数（次数 0 = 不限）。 */
export const DEFAULT_INTERVAL_MINUTES = 5
export const DEFAULT_RUNS = 10
export const MIN_INTERVAL_MINUTES = 1
/** 间隔上限一周：再长也没有意义，而且能让 setTimeout 永远不进溢出区间。 */
export const MAX_INTERVAL_MINUTES = 60 * 24 * 7

export const TASK_STATUSES = ['active', 'paused', 'completed']

export function emptyScheduled() {
  return { version: SCHEDULED_VERSION, tasks: [] }
}

function cleanText(value, max) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.slice(0, max)
}

/** 非空但没说具体值时的兜底标题：取消息首行。 */
function deriveTitle(prompt) {
  const line = String(prompt || '')
    .split('\n')
    .map((item) => item.trim())
    .find(Boolean)
  return cleanText(line || '定时任务', 120)
}

/** 间隔（分钟）→ 毫秒；非法值返回 0，由调用方据此报错。 */
export function intervalMinutesToMs(minutes) {
  const value = Number(minutes)
  if (!Number.isFinite(value)) return 0
  const rounded = Math.round(value)
  if (rounded < MIN_INTERVAL_MINUTES || rounded > MAX_INTERVAL_MINUTES) return 0
  return rounded * 60_000
}

/**
 * 次数：空 / 0 / 负数以外的非法值都收敛成「不限」（0）。
 * 需求里的「默认 10 次、无上限」体现在这里——只校验下界，不设上界。
 */
export function normalizeTotalRuns(value) {
  if (value === '' || value === null || value === undefined) return 0
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  const rounded = Math.floor(number)
  if (rounded <= 0) return 0
  return Math.min(rounded, 1_000_000)
}

function cleanStatus(value, { totalRuns, runs }) {
  if (totalRuns > 0 && runs >= totalRuns) return 'completed'
  return value === 'paused' ? 'paused' : 'active'
}

function cleanTask(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = cleanText(raw.id, 64)
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.slice(0, 20_000) : ''
  const sessionId = cleanText(raw.sessionId, 128)
  // 既没有会话也没有内容的任务没有任何可执行的东西，直接丢掉（磁盘上被改坏时的收敛）。
  if (!id || !prompt.trim() || !sessionId) return null
  const intervalMs = Number.isFinite(raw.intervalMs) ? Math.round(raw.intervalMs) : 0
  if (intervalMs < MIN_INTERVAL_MINUTES * 60_000) return null
  const totalRuns = normalizeTotalRuns(raw.totalRuns)
  const runs = Math.max(0, Math.floor(Number(raw.runs) || 0))
  const status = cleanStatus(raw.status, { totalRuns, runs })
  const nextRunAt = Number.isFinite(raw.nextRunAt) ? Math.round(raw.nextRunAt) : null
  return {
    id,
    title: cleanText(raw.title, 120) || deriveTitle(prompt),
    prompt,
    sessionId,
    nodeId: cleanText(raw.nodeId, 128) || null,
    cwd: cleanText(raw.cwd, 1024) || null,
    model: cleanText(raw.model, 200) || null,
    variant: cleanText(raw.variant, 40) || null,
    role: cleanText(raw.role, 120) || null,
    intervalMs,
    totalRuns,
    runs,
    status,
    createdAt: Number.isFinite(raw.createdAt) ? Math.round(raw.createdAt) : 0,
    lastRunAt: Number.isFinite(raw.lastRunAt) ? Math.round(raw.lastRunAt) : null,
    lastError: cleanText(raw.lastError, 300) || null,
    nextRunAt: status === 'active' && nextRunAt ? nextRunAt : null
  }
}

/** 读出磁盘内容后一律过这里：非法项丢弃，状态与计数收敛到自洽。 */
export function normalizeScheduled(raw) {
  const source = Array.isArray(raw?.tasks) ? raw.tasks : []
  const tasks = []
  const seen = new Set()
  for (const item of source) {
    const task = cleanTask(item)
    if (!task || seen.has(task.id)) continue
    seen.add(task.id)
    tasks.push(task)
  }
  return { version: SCHEDULED_VERSION, tasks }
}

export function findTask(scheduled, id) {
  return (scheduled?.tasks || []).find((task) => task.id === id) || null
}

/**
 * 新建一条任务。校验失败时原样返回旧列表并带上原因，调用方（IPC）直接把 error 回给页面。
 * `now` 可注入，方便单测断言 nextRunAt。
 */
export function createScheduledTask(scheduled, input = {}, { now = Date.now() } = {}) {
  const current = normalizeScheduled(scheduled)
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
  if (!prompt) return { ok: false, error: '先输入要定时发送的内容', scheduled: current }
  const sessionId = cleanText(input.sessionId, 128)
  if (!sessionId)
    return { ok: false, error: '这条对话还没有关联会话，先发送一条消息', scheduled: current }
  const intervalMs = intervalMinutesToMs(
    input.intervalMinutes === undefined ? DEFAULT_INTERVAL_MINUTES : input.intervalMinutes
  )
  if (!intervalMs) {
    return {
      ok: false,
      error: `间隔需要是 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 之间的整数（分钟）`,
      scheduled: current
    }
  }
  const totalRuns = normalizeTotalRuns(
    input.totalRuns === undefined ? DEFAULT_RUNS : input.totalRuns
  )
  const id = cleanText(input.id, 64)
  if (!id || findTask(current, id)) {
    return { ok: false, error: '定时任务 id 不合法', scheduled: current }
  }
  const task = {
    id,
    title: cleanText(input.title, 120) || deriveTitle(prompt),
    prompt,
    sessionId,
    nodeId: cleanText(input.nodeId, 128) || null,
    cwd: cleanText(input.cwd, 1024) || null,
    model: cleanText(input.model, 200) || null,
    variant: cleanText(input.variant, 40) || null,
    role: cleanText(input.role, 120) || null,
    intervalMs,
    totalRuns,
    runs: 0,
    status: 'active',
    createdAt: now,
    lastRunAt: null,
    lastError: null,
    nextRunAt: now + intervalMs
  }
  return {
    ok: true,
    task,
    scheduled: { version: SCHEDULED_VERSION, tasks: [...current.tasks, task] }
  }
}

/**
 * 更新一条任务：支持改间隔、次数、标题/消息正文，以及暂停/继续。
 * 从暂停恢复时重新计时（`now + interval`），避免一恢复就立刻补发积压的轮次。
 */
export function updateScheduledTask(scheduled, id, patch = {}, { now = Date.now() } = {}) {
  const current = normalizeScheduled(scheduled)
  const existing = findTask(current, id)
  if (!existing) return { ok: false, error: '定时任务不存在', scheduled: current }
  const next = { ...existing }

  if (patch.intervalMinutes !== undefined) {
    const intervalMs = intervalMinutesToMs(patch.intervalMinutes)
    if (!intervalMs) {
      return {
        ok: false,
        error: `间隔需要是 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 之间的整数（分钟）`,
        scheduled: current
      }
    }
    next.intervalMs = intervalMs
  }
  if (patch.totalRuns !== undefined) next.totalRuns = normalizeTotalRuns(patch.totalRuns)
  if (patch.prompt !== undefined) {
    const prompt = typeof patch.prompt === 'string' ? patch.prompt.trim() : ''
    if (!prompt) return { ok: false, error: '定时发送的内容不能为空', scheduled: current }
    next.prompt = prompt
  }
  if (patch.title !== undefined) next.title = cleanText(patch.title, 120) || next.title
  if (patch.status === 'paused' || patch.status === 'active') next.status = patch.status

  // 次数改大等于重新开闸：completed 的任务自动回到 active（runs 保持，不重置计数），
  // paused 仍然要用户自己点继续。
  const exhausted = next.totalRuns > 0 && next.runs >= next.totalRuns
  if (exhausted) {
    next.status = 'completed'
    next.nextRunAt = null
  } else if (next.status === 'completed') {
    next.status = 'active'
  }
  if (next.status === 'paused') {
    next.nextRunAt = null
  } else if (next.status === 'active') {
    if (
      existing.status !== 'active' ||
      patch.intervalMinutes !== undefined ||
      !existing.nextRunAt
    ) {
      next.nextRunAt = now + next.intervalMs
    }
  } else {
    next.nextRunAt = null
  }

  return {
    ok: true,
    task: next,
    scheduled: {
      version: SCHEDULED_VERSION,
      tasks: current.tasks.map((task) => (task.id === id ? next : task))
    }
  }
}

export function removeScheduledTask(scheduled, id) {
  const current = normalizeScheduled(scheduled)
  return {
    version: SCHEDULED_VERSION,
    tasks: current.tasks.filter((task) => task.id !== id)
  }
}

/** 删除某个会话时连带清掉它的定时任务，避免留下永远发不出去的任务。 */
export function removeTasksForSession(scheduled, sessionId) {
  const current = normalizeScheduled(scheduled)
  if (!sessionId) return current
  return {
    version: SCHEDULED_VERSION,
    tasks: current.tasks.filter((task) => task.sessionId !== sessionId)
  }
}

/** 已经到点、等待执行的任务（按到期时间排序，早的先跑）。 */
export function dueTasks(scheduled, now = Date.now()) {
  return (scheduled?.tasks || [])
    .filter((task) => task.status === 'active' && task.nextRunAt && task.nextRunAt <= now)
    .sort((a, b) => a.nextRunAt - b.nextRunAt)
}

/** 下一个到期时刻；没有活跃任务时为 null。 */
export function nextDueAt(scheduled) {
  let at = null
  for (const task of scheduled?.tasks || []) {
    if (task.status !== 'active' || !task.nextRunAt) continue
    if (at === null || task.nextRunAt < at) at = task.nextRunAt
  }
  return at
}

function applyTask(scheduled, id, updater) {
  const current = normalizeScheduled(scheduled)
  return {
    version: SCHEDULED_VERSION,
    tasks: current.tasks.map((task) => (task.id === id ? updater(task) : task))
  }
}

/**
 * 记一次「发出去了」：计数 +1，并排下一次。
 * 次数用尽后转 `completed` 并停表（下一次改次数/重新创建才能再跑）。
 */
export function recordTaskRun(scheduled, id, { at = Date.now() } = {}) {
  return applyTask(scheduled, id, (task) => {
    const runs = task.runs + 1
    const exhausted = task.totalRuns > 0 && runs >= task.totalRuns
    return {
      ...task,
      runs,
      lastRunAt: at,
      lastError: null,
      status: exhausted ? 'completed' : 'active',
      nextRunAt: exhausted ? null : at + task.intervalMs
    }
  })
}

/**
 * 记一次「这一轮到点了但没发出去」（会话正忙 / host 不可用）：**不消耗次数**，
 * 只把下一次推后一个间隔，并留下原因给界面显示。
 */
export function recordTaskSkip(scheduled, id, { at = Date.now(), error = '' } = {}) {
  return applyTask(scheduled, id, (task) => ({
    ...task,
    lastError: cleanText(error, 300) || task.lastError,
    nextRunAt: at + task.intervalMs
  }))
}
