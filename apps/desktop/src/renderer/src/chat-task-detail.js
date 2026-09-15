const SIZE_UNITS = ['B', 'KB', 'MB', 'GB']

export function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let size = bytes
  let unit = 0
  while (size >= 1024 && unit < SIZE_UNITS.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(unit === 0 || size >= 10 ? 0 : 1)} ${SIZE_UNITS[unit]}`
}

const SUBAGENT_STATUS_LABELS = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  killed: '已停止'
}

const BACKGROUND_STATUS_LABELS = {
  starting: '启动中',
  running: '运行中',
  finished: '已完成',
  killed: '已终止',
  failed: '失败',
  unknown_exited: '异常退出'
}

export function subagentStatusLabel(status) {
  return SUBAGENT_STATUS_LABELS[status] ?? status
}

export function backgroundTaskStatusLabel(status) {
  return BACKGROUND_STATUS_LABELS[status] ?? status
}

export function isSubagentRunning(task) {
  return task?.status === 'running'
}

export function isBackgroundTaskRunning(task) {
  return task?.status === 'starting' || task?.status === 'running'
}

const TIMELINE_KINDS = new Set(['thinking', 'text', 'tool', 'tool_result'])

export function buildSubagentTimeline(task) {
  const entries = Array.isArray(task?.timeline) ? task.timeline : []
  const steps = []
  entries.forEach((entry, index) => {
    const text = typeof entry?.text === 'string' ? entry.text : ''
    if (!text.trim()) return
    steps.push({
      key: `${entry?.id || index}:${index}`,
      // 未知 kind 按 thinking 渲染：至少不会把工具参数当正文 markdown 打出去。
      kind: TIMELINE_KINDS.has(entry?.kind) ? entry.kind : 'thinking',
      text,
      toolName: entry?.toolName || ''
    })
  })
  return steps
}

export function taskOutputWindowLabel({ start, end, size } = {}) {
  const total = `共 ${formatBytes(size)}`
  const shown = Number(end) - Number(start)
  if (!(Number(start) > 0)) return total
  return `已显示末尾 ${formatBytes(shown)} / ${total}`
}

export function taskElapsedMs(task, now) {
  const startedAt = Date.parse(task?.startedAt)
  if (!Number.isFinite(startedAt)) return null
  const finishedAt = task?.finishedAt ? Date.parse(task.finishedAt) : NaN
  return Math.max(0, (Number.isFinite(finishedAt) ? finishedAt : now) - startedAt)
}
