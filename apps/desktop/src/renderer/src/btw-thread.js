/**
 * By The Way（btw）抽屉的纯展示判定。
 *
 * btw 是一个 mica 运行实例：一次回答会经历「连模型 → 思考 → 调工具 → 流式出正文」，
 * 抽屉要把这条过程像主对话一样画出来，而「现在处在哪个阶段」「用的是哪个工具」这些判断
 * 不该内联在组件里（与 `chat-scroll.js` / `chat-conversation-nav.js` 同一套做法）。
 */

/** 正在回答的那一条（没有就是 null）。一次只回答一个问题，所以取最后一条即可。 */
export function btwRunningEntry(entries) {
  const list = Array.isArray(entries) ? entries : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.status === 'running') return list[index]
  }
  return null
}

/** 还在跑的那个工具（并行调用时取最后发起的那个，与「正在做什么」的读法一致）。 */
export function btwRunningTool(entry) {
  const tools = Array.isArray(entry?.tools) ? entry.tools : []
  for (let index = tools.length - 1; index >= 0; index -= 1) {
    if (tools[index]?.status === 'running') return tools[index]
  }
  return null
}

/**
 * 这一条现在处在哪个阶段：
 * - `tool`：有工具还在跑（哪怕已经开始出正文，工具是"正在发生的事"，优先显示）
 * - `answering`：已经在出正文
 * - `thinking`：出了思考但还没正文
 * - `connecting`：都还没有（刚发出去的请求）
 */
export function btwEntryPhase(entry) {
  if (!entry || entry.status !== 'running') return null
  if (btwRunningTool(entry)) return 'tool'
  if (entry.answer) return 'answering'
  if (entry.thinking) return 'thinking'
  return 'connecting'
}

/** 阶段文案（标题行右侧那一行）。返回空串表示不显示。 */
export function btwPhaseText(entry) {
  const phase = btwEntryPhase(entry)
  if (phase === 'tool') return `正在调用 ${btwRunningTool(entry)?.tool || '工具'}…`
  if (phase === 'answering') return '正在回答…'
  if (phase === 'thinking') return '正在思考…'
  return phase === 'connecting' ? '正在连接模型…' : ''
}

/**
 * 这一条已经跑了多久。
 *
 * 运行中按传入的 `now` 算（抽屉自己按秒 tick），结束后定在 `finishedAt` 上——已完成
 * 的条目不该跟着时钟一直涨。
 */
export function btwEntryElapsedMs(entry, now) {
  const started = Date.parse(entry?.startedAt || '')
  if (!Number.isFinite(started)) return 0
  if (entry?.status === 'running') return Math.max(0, (Number(now) || 0) - started)
  const finished = Date.parse(entry?.finishedAt || '')
  return Math.max(0, (Number.isFinite(finished) ? finished : Number(now) || 0) - started)
}

/**
 * 找出「上一份 btw 快照里还在回答、这一份已经有结果」的条目。
 *
 * 这是「什么时候该补一条提示」的全部判定：抽屉关着时回答抵达要提示（btw 是后台发生的，
 * 不说一声用户只会以为没反应），但快照在恢复重放时也会来一次，那时上一份快照是空的、
 * 不会命中——否则每打开一次会话都会把历史回答再提示一遍。回答期间的高频流式快照都还是
 * `running`，也就不会在逐字渲染时反复弹提示。
 */
export function newlyAnsweredBtwEntries(previous, next) {
  const before = new Map(
    (Array.isArray(previous?.entries) ? previous.entries : []).map((entry) => [
      entry.id,
      entry.status
    ])
  )
  return (Array.isArray(next?.entries) ? next.entries : []).filter(
    (entry) => entry.status !== 'running' && before.get(entry.id) === 'running'
  )
}
