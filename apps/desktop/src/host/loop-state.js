/**
 * 定时循环任务的纯数据模型（`userData/loops.json` 的形状、校验与状态转移）。
 *
 * 语义对齐 CLI 的 `/loop`：一个会话挂一个循环，每隔一段时间把同一段任务描述重新发一遍，
 * 直到用户停止。桌面端与 CLI 的差别只在「宿主是谁」——CLI 的 `LoopController` 活在 TUI
 * 进程里、随会话退出而消失，桌面端必须活在运行时进程里，才能在页签关掉、刷新、换设备
 * 打开时继续跑，所以这里多了一层落盘。
 *
 * 循环按 **nodeId**（工作区节点 id）而不是 sessionId 归属：草稿会话在发出第一条消息之前
 * 还没有 sessionId，而输入框的时钟面板允许在草稿上启动（启动即触发第一轮，那一轮才创建会话）。
 * nodeId 在整个生命周期里稳定，sessionId 是后来才补上的（`bindSession`）。
 */

import { MAX_LOOP_INTERVAL_MS, MIN_LOOP_INTERVAL_MS } from '@packages/mica-common/loopArgs.js'

export const LOOPS_VERSION = 1
export const LOOP_STATUSES = ['active', 'paused']

export function emptyLoops() {
  return { version: LOOPS_VERSION, loops: [] }
}

/** 任务描述是单行展示用的，压掉换行与多余空白，避免侧栏与 tooltip 撑开。 */
export function normalizeLoopTask(task) {
  return String(task ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 存储用：把间隔收敛进合法区间。磁盘上的旧值越界时钳制而不是丢弃，宁可跑一个稍长的间隔
 * 也不要让用户的循环凭空消失。
 */
function normalizeInterval(intervalMs) {
  const value = Math.round(Number(intervalMs))
  if (!Number.isFinite(value) || value < MIN_LOOP_INTERVAL_MS) return null
  return Math.min(value, MAX_LOOP_INTERVAL_MS)
}

/** 用户输入用：越界一律拒绝，不静默改写用户明确给出的间隔。 */
function isIntervalInRange(intervalMs) {
  const value = Math.round(Number(intervalMs))
  return Number.isFinite(value) && value >= MIN_LOOP_INTERVAL_MS && value <= MAX_LOOP_INTERVAL_MS
}

/** 一个合法条目：有 nodeId、有任务、间隔在范围内。其余字段按需派生。 */
export function normalizeLoop(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null
  const nodeId = typeof raw.nodeId === 'string' ? raw.nodeId.trim() : ''
  const task = normalizeLoopTask(raw.task)
  const intervalMs = normalizeInterval(raw.intervalMs)
  if (!nodeId || !task || intervalMs === null) return null

  const startedAt = Number.isFinite(Number(raw.startedAt)) ? Number(raw.startedAt) : now
  const status = LOOP_STATUSES.includes(raw.status) ? raw.status : 'active'
  const fireCount =
    Number.isFinite(Number(raw.fireCount)) && Number(raw.fireCount) > 0
      ? Math.round(Number(raw.fireCount))
      : 0
  const lastFireAt = Number.isFinite(Number(raw.lastFireAt)) ? Number(raw.lastFireAt) : null
  const lastError = typeof raw.lastError === 'string' && raw.lastError ? raw.lastError : null

  // 暂停的循环没有下次触发时刻；续跑时重新计时（与 CLI「修改后从新时刻重新计时」一致）。
  let nextFireAt = null
  if (status === 'active') {
    nextFireAt = Number.isFinite(Number(raw.nextFireAt))
      ? Number(raw.nextFireAt)
      : startedAt + intervalMs
  }

  return {
    nodeId,
    sessionId:
      typeof raw.sessionId === 'string' && raw.sessionId.trim() ? raw.sessionId.trim() : null,
    cwd: typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : null,
    intervalMs,
    task,
    status,
    startedAt,
    fireCount,
    lastFireAt,
    nextFireAt,
    lastError
  }
}

export function normalizeLoops(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.loops)) return emptyLoops()
  const seen = new Set()
  const loops = []
  for (const item of raw.loops) {
    const loop = normalizeLoop(item)
    // 同一个 nodeId 只留第一条：文件被手改成重复条目时，宁可丢一条也不要两个定时器打同一个会话。
    if (!loop || seen.has(loop.nodeId)) continue
    seen.add(loop.nodeId)
    loops.push(loop)
  }
  return { version: LOOPS_VERSION, loops }
}

export function findLoop(loops, nodeId) {
  return loops?.loops?.find((loop) => loop.nodeId === nodeId) || null
}

function replaceLoop(loops, next) {
  return {
    version: LOOPS_VERSION,
    loops: loops.loops.map((loop) => (loop.nodeId === next.nodeId ? next : loop))
  }
}

/**
 * 启动（或替换）某个节点上的循环。首次触发不在这里——调用方启动后立刻走一次
 * `markFired`，与 CLI「启动即执行第一次」一致。
 */
export function startLoop(
  loops,
  { nodeId, sessionId = null, cwd = null, intervalMs, task, now = Date.now() }
) {
  const loop = normalizeLoop(
    {
      nodeId,
      sessionId,
      cwd,
      intervalMs,
      task,
      status: 'active',
      startedAt: now,
      fireCount: 0,
      nextFireAt: now
    },
    now
  )
  if (!loop) return { ok: false, error: '定时任务的间隔或内容不合法', loops }
  const exists = Boolean(findLoop(loops, loop.nodeId))
  const next = exists
    ? replaceLoop(loops, loop)
    : { version: LOOPS_VERSION, loops: [...loops.loops, loop] }
  return { ok: true, replaced: exists, loop, loops: next }
}

export function removeLoop(loops, nodeId) {
  return { version: LOOPS_VERSION, loops: loops.loops.filter((loop) => loop.nodeId !== nodeId) }
}

/** 会话被删除时连带清掉循环：会话文件没了，循环只会每轮失败。 */
export function removeLoopsForSession(loops, sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!id) return loops
  const next = loops.loops.filter((loop) => loop.sessionId !== id)
  return next.length === loops.loops.length ? loops : { version: LOOPS_VERSION, loops: next }
}

/** 草稿节点拿到 sessionId 时补上（`turn/started` 里才知道），供归属与忙判定使用。 */
export function bindLoopSession(loops, nodeId, sessionId) {
  const loop = findLoop(loops, nodeId)
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!loop || !id || loop.sessionId === id) return loops
  return replaceLoop(loops, { ...loop, sessionId: id })
}

export function setLoopStatus(loops, nodeId, status, now = Date.now()) {
  const loop = findLoop(loops, nodeId)
  if (!loop || !LOOP_STATUSES.includes(status)) return { ok: false, error: '定时任务不存在', loops }
  const next =
    status === 'active'
      ? { ...loop, status, nextFireAt: now + loop.intervalMs, lastError: null }
      : { ...loop, status, nextFireAt: null }
  return { ok: true, loop: next, loops: replaceLoop(loops, next) }
}

export function setLoopInterval(loops, nodeId, intervalMs, now = Date.now()) {
  const loop = findLoop(loops, nodeId)
  if (!loop) return { ok: false, error: '定时任务不存在', loops }
  if (!isIntervalInRange(intervalMs))
    return { ok: false, error: '间隔必须是 10 秒到一周之间', loops }
  const value = Math.round(Number(intervalMs))
  const next = {
    ...loop,
    intervalMs: value,
    // 改间隔后从当前时刻重新计时，避免刚改完就立刻触发一次。
    nextFireAt: loop.status === 'active' ? now + value : null
  }
  return { ok: true, loop: next, loops: replaceLoop(loops, next) }
}

export function setLoopTask(loops, nodeId, task) {
  const loop = findLoop(loops, nodeId)
  const value = normalizeLoopTask(task)
  if (!loop) return { ok: false, error: '定时任务不存在', loops }
  if (!value) return { ok: false, error: '任务内容不能为空', loops }
  const next = { ...loop, task: value }
  return { ok: true, loop: next, loops: replaceLoop(loops, next) }
}

/** 记一轮触发：计数 +1，下一轮从 `at` 起算。`error` 是这一轮的失败原因（成功则清空）。 */
export function markLoopFired(loops, nodeId, { at = Date.now(), error = null } = {}) {
  const loop = findLoop(loops, nodeId)
  if (!loop) return loops
  const next = {
    ...loop,
    fireCount: loop.fireCount + 1,
    lastFireAt: at,
    lastError: error || null,
    nextFireAt: loop.status === 'active' ? at + loop.intervalMs : null
  }
  return replaceLoop(loops, next)
}

/** 跳过一轮（会话忙等）：不计入执行次数，只把下一次推后一个间隔。 */
export function markLoopSkipped(loops, nodeId, { at = Date.now(), error = null } = {}) {
  const loop = findLoop(loops, nodeId)
  if (!loop) return loops
  const next = {
    ...loop,
    lastError: error || '本次跳过，稍后重试',
    nextFireAt: loop.status === 'active' ? at + loop.intervalMs : null
  }
  return replaceLoop(loops, next)
}

/** 最早已到期的 active 循环；没有则 null。 */
export function dueLoop(loops, now) {
  let earliest = null
  for (const loop of loops?.loops ?? []) {
    if (loop.status !== 'active' || !Number.isFinite(loop.nextFireAt)) continue
    if (loop.nextFireAt > now) continue
    if (!earliest || loop.nextFireAt < earliest.nextFireAt) earliest = loop
  }
  return earliest
}

/** 下一次触发时刻（用于排定时器），没有 active 循环时 null。 */
export function nextLoopDueAt(loops) {
  let earliest = null
  for (const loop of loops?.loops ?? []) {
    if (loop.status !== 'active' || !Number.isFinite(loop.nextFireAt)) continue
    if (earliest === null || loop.nextFireAt < earliest) earliest = loop.nextFireAt
  }
  return earliest
}

/**
 * 启动时把已经过期的循环收敛到「立刻跑一轮」。进程关掉期间的轮次不补发——循环的语义是
 * 「从现在起的每 N 分钟」，补发一批积压轮次会把同一个任务连发好几次。
 */
export function catchUpLoops(loops, now = Date.now()) {
  let changed = false
  const next = loops.loops.map((loop) => {
    if (loop.status !== 'active' || !Number.isFinite(loop.nextFireAt) || loop.nextFireAt > now)
      return loop
    changed = true
    return { ...loop, nextFireAt: now }
  })
  return changed ? { version: LOOPS_VERSION, loops: next } : loops
}
