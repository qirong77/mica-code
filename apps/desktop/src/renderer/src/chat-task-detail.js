import { parseToolArgs } from './chat-tool-display'

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
  partial: '部分完成',
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
const timelineInvocationIds = new WeakMap()
const timelineResultSteps = new WeakSet()

/** 时间线条目自带的写入时间（毫秒）；缺失时返回 undefined，不编造时间。 */
function entryTime(entry) {
  const value = Date.parse(entry?.at)
  return Number.isFinite(value) ? value : undefined
}

function invocationKey(entry) {
  const id = typeof entry?.id === 'string' ? entry.id : ''
  const prefix = entry?.kind === 'tool' ? 'tool:' : 'result:'
  if (!id.startsWith(prefix)) return ''
  const key = id.slice(prefix.length)
  // The name is the host's fallback when no provider id was supplied; it does
  // not identify an invocation and may occur in several parallel calls.
  return key && key !== entry?.toolName ? key : ''
}

/**
 * Pair a result with the call that produced it.
 *
 * The host keeps the provider call id in both timeline entries (`tool:<id>` and
 * `result:<id>`).  Looking only at the tool name is tempting, but it breaks as
 * soon as two `read_file` calls are in flight together or results arrive out of
 * order.  The name fallback is intentionally kept for old records/providers
 * which did not expose a call id.
 */
function takePendingToolStep(steps, entry, toolName) {
  const resultKey = invocationKey(entry)
  if (resultKey) {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index]
      if (step.kind !== 'tool' || hasSubagentToolResult(step)) continue
      if (timelineInvocationIds.get(step) === resultKey && (!toolName || !step.toolName || step.toolName === toolName)) {
        return step
      }
    }
  }
  // Fall back only if at least one side lacks an id and the match is unique.
  // A result whose call was truncated must not attach to a different known id.
  const candidates = steps.filter((step) =>
    step.kind === 'tool' && !hasSubagentToolResult(step) &&
    (!toolName || !step.toolName || step.toolName === toolName) &&
    (!resultKey || !timelineInvocationIds.get(step))
  )
  return candidates.length === 1 ? candidates[0] : null
}

export function buildSubagentTimeline(task) {
  const entries = Array.isArray(task?.timeline) ? task.timeline : []
  const steps = []
  entries.forEach((entry, index) => {
    const text = typeof entry?.text === 'string' ? entry.text : ''
    const key = `${entry?.id || index}:${index}`
    // 未知 kind 按 thinking 渲染：至少不会把工具参数当正文 markdown 打出去。
    const kind = TIMELINE_KINDS.has(entry?.kind) ? entry.kind : 'thinking'
    if (!text.trim() && kind !== 'tool' && kind !== 'tool_result') return
    const toolName = entry?.toolName || ''
    if (kind === 'tool') {
      const step = {
        key,
        kind,
        toolName,
        argsText: text,
        resultText: '',
        startedAt: entryTime(entry)
      }
      timelineInvocationIds.set(step, invocationKey(entry))
      steps.push(step)
      return
    }
    if (kind === 'tool_result') {
      const target = takePendingToolStep(steps, entry, toolName)
      if (target) {
        target.resultText = text
        timelineResultSteps.add(target)
        target.finishedAt = entryTime(entry)
        return
      }
      // 找不到对应调用（时间线被截断过）时单独成一步，不能把输出丢掉。
      steps.push({ key, kind, toolName, text, startedAt: entryTime(entry) })
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

function hasSubagentToolResult(step) {
  return step?.kind === 'tool_result' || timelineResultSteps.has(step) || Boolean(step?.resultText)
}

/** Live ids come from the executing host; never infer an active invocation from
 * an unmatched historical row. Several calls can be live simultaneously. */
export function isSubagentToolRunning(step, task) {
  if (task?.status !== 'running' || step?.kind !== 'tool' || hasSubagentToolResult(step)) return false
  const id = timelineInvocationIds.get(step)
  return Boolean(id && Array.isArray(task?.activeToolIds) && task.activeToolIds.includes(id))
}

/**
 * 把时间线里的一步工具调用转成**回合日志那一行**要的形状。
 *
 * 主对话的工具行数据来自 app-server 的工具事件（带 `displayText` 与起止时间）；
 * subagent 的时间线只有原始入参 JSON、结果文本和每条记录的写入时间。这里把状态
 * 与耗时补齐，两边的工具行才能真正共用同一个 `ToolActivityRow` / `ToolDetailDialog`，
 * 而不是各画一套（否则同一个工具在主对话和 subagent 详情里长得不一样）。
 */
export function subagentToolOf(step, running = false) {
  // 配不上调用的孤立结果（时间线被截断过）本身就只有输出，没有入参。
  const output = step?.resultText || (step?.kind === 'tool_result' ? step?.text : '') || ''
  const received = hasSubagentToolResult(step)
  const active = running === true && !received
  const hasStartedAt = Number.isFinite(step?.startedAt)
  const hasFinishedAt = Number.isFinite(step?.finishedAt)
  // 旧记录可能只有工具结果、没有结果写入时间。不能把这种「未知」当成
  // 「从调用开始一直跑到现在」——否则详情里每一行都会显示同一个当前耗时。
  const durationKnown = active ? hasStartedAt : hasStartedAt && hasFinishedAt
  return {
    id: step?.key,
    tool: step?.toolName || '',
    input: parseToolArgs(step?.argsText),
    output,
    status: received ? 'completed' : active ? 'running' : 'unknown',
    startedAt: step?.startedAt,
    finishedAt: step?.finishedAt,
    durationKnown,
    ...(received ? {} : { unresolved: true })
  }
}

/**
 * 时间线内容的指纹。
 *
 * 详情弹窗每秒轮询一次，host 每次都会给一份新的数组与条目对象；直接用它当
 * `useMemo` 依赖会让所有步骤每秒重建一次，`memo` 也就全部失效。时间线是
 * 有界时间线达到上限后会从头部丢弃条目：条数与最后一条相同时，中间也可能不同。
 */
export function timelineSignature(task) {
  const entries = Array.isArray(task?.timeline) ? task.timeline : []
  if (entries.length === 0) return '0::::'
  const first = entries[0]
  const last = entries.at(-1)
  // Timeline updates are append-only and only the last entry is merged. The
  // first entry catches head truncation without serializing all 120 entries on
  // every poll.
  return JSON.stringify([
    task?.timelineTruncated === true,
    entries.length,
    first?.id ?? '',
    first?.kind ?? '',
    first?.text ?? '',
    last?.id ?? '',
    last?.kind ?? '',
    last?.text ?? ''
  ])
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
  if (JSON.stringify(a.activeToolIds) !== JSON.stringify(b.activeToolIds)) return false
  if (
    a.status !== b.status ||
    a.finishedAt !== b.finishedAt ||
    a.interrupted !== b.interrupted ||
    a.timelineTruncated !== b.timelineTruncated ||
    a.result !== b.result ||
    a.error !== b.error
  ) return false
  // 结果与错误是收尾时才出现的字段，不能只靠 status 判断（失败原因可能补充得更晚）。
  const au = a.usage || {}
  const bu = b.usage || {}
  return (
    au.records === bu.records &&
    au.inputTokens === bu.inputTokens &&
    au.outputTokens === bu.outputTokens &&
    au.cachedInputTokens === bu.cachedInputTokens &&
    au.totalTokens === bu.totalTokens
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
