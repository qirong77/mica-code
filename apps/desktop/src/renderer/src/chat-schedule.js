/**
 * 定时任务的展示层纯函数：表单校验、进度/倒计时文案、按会话筛选。
 *
 * 默认值、间隔上下限与次数规则必须和 host 的 `src/host/scheduled-tasks.js` 保持一致
 * （跨进程不能直接 import），改动时两边一起改，单测锁住这里的口径。
 */

export const DEFAULT_INTERVAL_MINUTES = 5
export const DEFAULT_RUNS = 10
export const MIN_INTERVAL_MINUTES = 1
export const MAX_INTERVAL_MINUTES = 60 * 24 * 7

const INTERVAL_ERROR = `间隔需要是 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 之间的整数（分钟）`

/**
 * 校验输入框里的「间隔 + 次数」。次数留空（或 0）= 不限次，所以这里不做上界校验。
 * 返回 totalRuns 是 host 口径：0 表示不限。
 */
export function parseScheduleDraft({ intervalMinutes, runs } = {}) {
  const minutes = Number(intervalMinutes)
  if (
    !Number.isFinite(minutes) ||
    Math.round(minutes) < MIN_INTERVAL_MINUTES ||
    Math.round(minutes) > MAX_INTERVAL_MINUTES
  ) {
    return { ok: false, error: INTERVAL_ERROR }
  }
  const rawRuns = typeof runs === 'string' ? runs.trim() : runs
  let totalRuns = 0
  if (rawRuns !== '' && rawRuns !== null && rawRuns !== undefined) {
    const value = Number(rawRuns)
    if (!Number.isFinite(value)) return { ok: false, error: '次数需要是正整数，留空表示不限次' }
    totalRuns = Math.max(0, Math.floor(value))
  }
  return { ok: true, intervalMinutes: Math.round(minutes), totalRuns }
}

/** 间隔的中文文案：整小时/整天的用大单位，其余按分钟。 */
export function formatIntervalMinutes(minutes) {
  const value = Math.max(1, Math.round(Number(minutes) || 0))
  if (value % 1440 === 0) return `${value / 1440} 天`
  if (value % 60 === 0) return `${value / 60} 小时`
  return `${value} 分钟`
}

/** 「3/10」；不限次时是「3/不限」。 */
export function taskProgress(task) {
  const runs = Math.max(0, Math.floor(Number(task?.runs) || 0))
  const total = Math.max(0, Math.floor(Number(task?.totalRuns) || 0))
  return `${runs}/${total > 0 ? total : '不限'}`
}

export function taskStatusLabel(task) {
  if (task?.status === 'paused') return '已暂停'
  if (task?.status === 'completed') return '已完成'
  return '进行中'
}

/** 下一次触发倒计时；已到期显示「即将触发」，没有下一次（暂停/完成）返回空串。 */
export function countdownLabel(nextRunAt, now = Date.now()) {
  const at = Number(nextRunAt)
  if (!Number.isFinite(at) || at <= 0) return ''
  const remaining = at - now
  if (remaining <= 1000) return '即将触发'
  if (remaining < 60_000) return `${Math.ceil(remaining / 1000)} 秒后`
  if (remaining < 3_600_000) return `${Math.round(remaining / 60_000)} 分钟后`
  if (remaining < 86_400_000) return `${Math.round(remaining / 3_600_000)} 小时后`
  return `${Math.round(remaining / 86_400_000)} 天后`
}

/** 属于某个对话的任务：按会话 id 认领，会话还没绑定时退回节点 id。 */
export function tasksOfSession(tasks, { sessionId, nodeId } = {}) {
  const list = Array.isArray(tasks) ? tasks : []
  return list.filter(
    (task) =>
      (!!sessionId && task.sessionId === sessionId) ||
      (!!nodeId && !sessionId && task.nodeId === nodeId)
  )
}

/** 侧栏顺序：进行中在前（按最近到期），暂停/完成按创建时间倒序垫后。 */
export function sortTasksForList(tasks) {
  const list = Array.isArray(tasks) ? [...tasks] : []
  const rank = (task) => (task.status === 'active' ? 0 : task.status === 'paused' ? 1 : 2)
  return list.sort((a, b) => {
    const order = rank(a) - rank(b)
    if (order !== 0) return order
    if (a.status === 'active') return (a.nextRunAt || 0) - (b.nextRunAt || 0)
    return (b.createdAt || 0) - (a.createdAt || 0)
  })
}
