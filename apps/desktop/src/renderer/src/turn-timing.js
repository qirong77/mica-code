/**
 * 最近一轮的耗时分解。
 *
 * 数据只来自渲染层已经收到的事件流（`step_start` / `text` / `reasoning` /
 * `tool_use` / `step_finish`），不新增协议：一轮的时间按「在等什么」切成首尾相接的
 * 区间——请求发出后到第一个 token 是「等待模型」，流式输出期间是「模型输出」，
 * 工具从 item/started 到 item/completed 是「工具执行」。区间之间不留空隙，所以
 * 三类合计加上收尾就是整轮耗时；点击某一类再按时间顺序看每次的明细。
 *
 * 只保留最近一轮：`step_start` 直接丢弃上一轮。切会话 / 重启后没有事件可重放时
 * 就是空的，界面如实说「还没有可分析的轮次」，不落盘也不伪造。
 */

const GROUP_DEFS = [
  { id: 'wait', label: '等待模型' },
  { id: 'generate', label: '模型输出' },
  { id: 'tool', label: '工具调用' }
]

export function createTurnTimingState() {
  return {
    startedAt: 0,
    endedAt: 0,
    lastAt: 0,
    segments: [],
    openIndex: -1,
    outcome: null
  }
}

function lastEnd(segments, fallback) {
  const last = segments[segments.length - 1]
  return last ? last.end : fallback
}

/** 把仍打开的区间收到 `at`：模型输出「延续到工具调用发出」，工具「跑到结果回来」。 */
function closeOpenAt(segments, openIndex, at) {
  if (openIndex < 0) return segments
  const segment = segments[openIndex]
  if (!segment || at <= segment.end) return segments
  const next = segments.slice()
  next[openIndex] = { ...segment, end: at }
  return next
}

/** 两个活动区间之间的空档就是「等待模型」：上一段结束 → 这一段开始。 */
function pushWait(segments, from, to) {
  if (!(to > from)) return segments
  return [...segments, { kind: 'wait', start: from, end: to }]
}

function findToolSegment(segments, callID, openIndex) {
  if (openIndex >= 0) {
    const segment = segments[openIndex]
    if (segment?.kind === 'tool' && (!callID || segment.callID === callID)) return openIndex
  }
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (segment.kind !== 'tool') continue
    if (segment.status !== 'pending') continue
    if (!callID || segment.callID === callID) return index
  }
  return -1
}

function turnOutcome(reason) {
  if (reason === 'aborted') return 'aborted'
  if (reason === 'error') return 'error'
  return 'completed'
}

export function applyTurnTimingEvent(state, event) {
  if (!event || typeof event.type !== 'string') return state
  const raw = Number(event.timestamp)
  const at = Number.isFinite(raw) && raw > 0 ? raw : Date.now()

  if (event.type === 'step_start') {
    return { ...createTurnTimingState(), startedAt: at, lastAt: at }
  }
  if (!state || !state.startedAt) return state

  if (event.type === 'text' || event.type === 'reasoning') {
    const text = typeof event.part?.text === 'string' ? event.part.text : ''
    const open = state.openIndex >= 0 ? state.segments[state.openIndex] : null
    if (open?.kind === 'generate') {
      const segments = state.segments.slice()
      const end = Math.max(open.end, at)
      segments[state.openIndex] = { ...open, end, chars: open.chars + text.length }
      return { ...state, segments, lastAt: end }
    }
    let segments = closeOpenAt(state.segments.slice(), state.openIndex, at)
    const idleFrom = lastEnd(segments, state.lastAt)
    segments = pushWait(segments, idleFrom, at)
    segments.push({ kind: 'generate', start: at, end: at, chars: text.length })
    return { ...state, segments, openIndex: segments.length - 1, lastAt: at }
  }

  if (event.type === 'tool_use') {
    const part = event.part
    if (!part?.tool) return state
    const callID = part.callID || ''
    const status = part.state?.status || 'completed'

    if (status === 'pending' || status === 'running') {
      let segments = closeOpenAt(state.segments.slice(), state.openIndex, at)
      const idleFrom = lastEnd(segments, state.lastAt)
      segments = pushWait(segments, idleFrom, at)
      segments.push({
        kind: 'tool',
        start: at,
        end: at,
        callID,
        tool: part.tool,
        displayText: part.displayText || '',
        status: 'pending'
      })
      return { ...state, segments, openIndex: segments.length - 1, lastAt: at }
    }

    const index = findToolSegment(state.segments, callID, state.openIndex)
    if (index < 0) return state
    const segments = state.segments.slice()
    const segment = segments[index]
    const end = Math.max(segment.end, at)
    segments[index] = { ...segment, end, status: 'completed' }
    return { ...state, segments, openIndex: -1, lastAt: end }
  }

  if (event.type === 'step_finish') {
    const outcome = turnOutcome(event.part?.reason)
    let segments = closeOpenAt(state.segments.slice(), state.openIndex, at)
    // 收尾时仍没回来的工具（中止 / 出错）如实标在它自己那条上，而不是吞掉。
    if (state.openIndex >= 0) {
      const open = segments[state.openIndex]
      if (open?.kind === 'tool' && open.status === 'pending') {
        segments[state.openIndex] = { ...open, status: outcome }
      }
    }
    const idleFrom = lastEnd(segments, state.lastAt)
    segments = pushWait(segments, idleFrom, at)
    if (segments.length && segments[segments.length - 1].kind === 'wait') {
      const last = segments[segments.length - 1]
      segments[segments.length - 1] = { ...last, tail: true }
    }
    return { ...state, segments, openIndex: -1, endedAt: at, lastAt: at, outcome }
  }

  return state
}

/**
 * 聚合出界面要的形态：总耗时、三类合计与占比、每一类按时间顺序的明细。
 * 运行中 `endedAt` 还没有，用当前时刻继续计时。
 */
export function summarizeTurnTiming(state, nowMs = Date.now()) {
  if (!state?.startedAt) return null
  const endedAt = state.endedAt || Math.max(nowMs, state.startedAt)
  const totalMs = Math.max(0, endedAt - state.startedAt)
  // 运行中：仍打开的那一段（模型正在输出 / 工具正在跑）算到此刻；没有打开段说明
  // 正等着下一次请求，补一条「进行中」的等待，占比条与总耗时才始终连续。
  const segments = state.segments.map((segment, index) =>
    !state.endedAt && index === state.openIndex ? { ...segment, end: endedAt } : segment
  )
  if (!state.endedAt && state.openIndex < 0 && endedAt > state.lastAt) {
    segments.push({ kind: 'wait', start: state.lastAt, end: endedAt, live: true })
  }
  const groups = GROUP_DEFS.map((definition) => {
    const items = []
    for (const segment of segments) {
      if (segment.kind !== definition.id) continue
      items.push({
        start: segment.start,
        offsetMs: Math.max(0, segment.start - state.startedAt),
        durationMs: Math.max(0, segment.end - segment.start),
        tail: Boolean(segment.tail),
        live: Boolean(segment.live),
        tool: segment.tool || '',
        displayText: segment.displayText || '',
        status: segment.status || '',
        chars: segment.chars || 0
      })
    }
    const groupTotal = items.reduce((sum, item) => sum + item.durationMs, 0)
    return {
      id: definition.id,
      label: definition.label,
      items,
      count: items.length,
      totalMs: groupTotal,
      ratio: totalMs > 0 ? groupTotal / totalMs : 0
    }
  })
  return {
    startedAt: state.startedAt,
    endedAt,
    totalMs,
    running: !state.endedAt,
    outcome: state.outcome,
    groups,
    requests: groups[0].items.filter((item) => !item.tail && !item.live).length,
    toolCalls: groups[2].items.length
  }
}

/**
 * 各组的整数百分比：三行加起来必须正好 100%，否则用户会觉得时间被多算或少算了。
 * 舍入的零头记到最费时间的那一类上（`<1%` 的组也参与，它的零头同样归到最大项）。
 */
export function groupPercents(groups) {
  const percents = groups.map((group) => (group.count > 0 ? Math.round(group.ratio * 100) : 0))
  const drift = 100 - percents.reduce((sum, value) => sum + value, 0)
  if (!drift) return percents
  let heaviest = -1
  groups.forEach((group, index) => {
    if (!group.count) return
    if (heaviest < 0 || group.totalMs > groups[heaviest].totalMs) heaviest = index
  })
  if (heaviest >= 0) percents[heaviest] += drift
  return percents
}
