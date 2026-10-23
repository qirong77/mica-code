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

/**
 * 找最近一条还没挂上结果的工具调用。
 *
 * 工具的入参与结果原本是两条平铺记录（`tool` / `tool_result`），详情弹窗里
 * 「一次调用」才是读者心里的单位，所以这里配成一步。只看最后一个候选：
 * 流式输出里结果紧跟在调用后面，跳过中间未配对的调用反而会错配。
 */
function takePendingToolStep(steps, toolName) {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]
    if (step.kind !== 'tool' || step.resultText) continue
    if (toolName && step.toolName && step.toolName !== toolName) return null
    return step
  }
  return null
}

export function buildSubagentTimeline(task) {
  const entries = Array.isArray(task?.timeline) ? task.timeline : []
  const steps = []
  entries.forEach((entry, index) => {
    const text = typeof entry?.text === 'string' ? entry.text : ''
    if (!text.trim()) return
    const key = `${entry?.id || index}:${index}`
    // 未知 kind 按 thinking 渲染：至少不会把工具参数当正文 markdown 打出去。
    const kind = TIMELINE_KINDS.has(entry?.kind) ? entry.kind : 'thinking'
    const toolName = entry?.toolName || ''
    if (kind === 'tool') {
      steps.push({ key, kind, toolName, argsText: text, resultText: '' })
      return
    }
    if (kind === 'tool_result') {
      const target = takePendingToolStep(steps, toolName)
      if (target) {
        target.resultText = text
        return
      }
      // 找不到对应调用（时间线被截断过）时单独成一步，不能把输出丢掉。
      steps.push({ key, kind, toolName, text })
      return
    }
    steps.push({
      key,
      kind,
      text,
      toolName
    })
  })
  return steps
}

/**
 * 时间线内容的指纹。
 *
 * 详情弹窗每秒轮询一次，host 每次都会给一份新的数组与条目对象；直接用它当
 * `useMemo` 依赖会让所有步骤每秒重建一次，`memo` 也就全部失效。时间线是
 * append-only 的（同一 id 的增量只合并进最后一条），所以「条数 + 最后一条的
 * id/kind/长度」变化就等价于内容变化。
 */
export function timelineSignature(task) {
  const entries = Array.isArray(task?.timeline) ? task.timeline : []
  const last = entries.at(-1)
  return [entries.length, last?.id ?? '', last?.kind ?? '', last?.text?.length ?? 0].join(':')
}

/**
 * 两次轮询的结果是否等价（等价就复用旧对象，让 React 直接 bail out）。
 *
 * 任务在跑时 detail 每秒都是新对象，但绝大多数时候内容没变：不判等的话，
 * 弹窗连同里面所有步骤每秒重渲染一次，滚动和输入都会跟着发涩。
 */
export function sameTaskDetail(previous, next) {
  if (!previous || !next) return previous === next
  if (previous === next) return true
  if (previous.content !== next.content) return false
  if (previous.size !== next.size || previous.start !== next.start || previous.end !== next.end) {
    return false
  }
  if (timelineSignature(previous.task) !== timelineSignature(next.task)) return false
  const a = previous.task || {}
  const b = next.task || {}
  if (a.status !== b.status || a.finishedAt !== b.finishedAt) return false
  // 结果与错误是收尾时才出现的字段，不能只靠 status 判断（失败原因可能补充得更晚）。
  if (a.result !== b.result || a.error !== b.error) return false
  const au = a.usage || {}
  const bu = b.usage || {}
  return (
    au.records === bu.records &&
    au.inputTokens === bu.inputTokens &&
    au.outputTokens === bu.outputTokens &&
    au.cachedInputTokens === bu.cachedInputTokens
  )
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

const WAIT_KIND_LABELS = {
  task: '后台任务',
  process: '进程',
  file: '文件',
  command: '命令',
  http: 'HTTP',
  port: '端口',
  duration: '时长'
}

/** wait_for 等待条件的类别文案（dock 行首）。 */
export function waitTaskKindLabel(kind) {
  return WAIT_KIND_LABELS[kind] ?? String(kind || '条件')
}

/**
 * dock 行上的一句话：优先用模型给的 reason（「为什么等」），否则退回条件
 * 标签。duration 等待的标签只是「等待 50s」，所以有 reason 时它才是唯一能
 * 说明在等什么的信息。
 */
export function waitTaskSummary(task) {
  const reason = String(task?.reason || '').trim()
  if (reason) return reason
  return String(task?.label || '').trim() || '等待条件'
}

/**
 * wait_for dock 行的悬停提示：条件、精确到毫秒的开始时间与已轮询次数。
 * 侧栏/状态行都不做每秒 tick，倒计时与耗时只在 tooltip 里给。
 */
export function waitTaskTooltip(task) {
  const lines = []
  const reason = String(task?.reason || '').trim()
  if (reason) lines.push(reason)
  lines.push(String(task?.label || '').trim() || '等待条件')
  const elapsed = taskElapsedMs(task, Date.now())
  if (elapsed != null) lines.push(`已等待 ${Math.round(elapsed / 1000)} 秒`)
  const polls = Number(task?.polls)
  if (Number.isFinite(polls) && polls > 0) lines.push(`已轮询 ${polls} 次`)
  const detail = String(task?.detail || '').trim()
  if (detail) lines.push(`最近一次检查：${detail}`)
  return lines.join('\n')
}
