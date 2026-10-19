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

/** 12_400 → `12.4k`，与主对话状态栏同一个读法。 */
function shortTokens(value) {
  const tokens = Number(value)
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens < 1000) return String(Math.round(tokens))
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
}

/**
 * 抽屉底部那行「模型 · 上下文占用」文案。
 *
 * btw 线程是一次独立的运行，它的上下文与主对话无关，所以状态栏也得自己带一份：
 * `tokens` 是**最近一次请求**的 input（= 现在这条线程占了多少，与主对话状态栏同口径），
 * 压缩之后到下一次请求之前是估算值——那时必须标出来，否则压完看起来没变。
 * 返回空串表示这条线程还没有任何请求（不显示一行空数据）。
 */
export function btwContextLabel(context) {
  if (!context) return ''
  const parts = []
  if (context.model) parts.push(context.model)
  const tokens = Number(context.tokens)
  if (Number.isFinite(tokens) && tokens > 0) {
    const window = Number(context.contextWindowSize)
    const percent = Number.isFinite(window) && window > 0 ? Math.round((tokens / window) * 100) : 0
    const head = `${shortTokens(tokens)}${Number.isFinite(window) && window > 0 ? ` / ${shortTokens(window)}` : ''}`
    parts.push(`${context.estimated ? '≈' : ''}${head}${percent > 0 ? ` (${percent}%)` : ''}`)
  }
  return parts.join(' · ')
}

/** 悬停说明：累计用量与缓存命中（一行里塞不下，也不该一直占着宽度）。 */
export function btwContextTitle(context) {
  if (!context) return ''
  const lines = []
  if (context.estimated) lines.push('上下文占用是本地压缩后的估算值，下一次请求会刷新')
  const totalIn = Number(context.totalInputTokens) || 0
  const totalOut = Number(context.totalOutputTokens) || 0
  if (totalIn || totalOut)
    lines.push(`累计 ${shortTokens(totalIn)} in / ${shortTokens(totalOut)} out`)
  const cached = Number(context.cachedTokens)
  const tokens = Number(context.tokens)
  if (Number.isFinite(cached) && Number.isFinite(tokens) && tokens > 0)
    lines.push(`最近一次命中缓存 ${shortTokens(cached)}`)
  if (Number.isFinite(Number(context.requests)) && Number(context.requests) > 0)
    lines.push(`共 ${Number(context.requests)} 次请求`)
  return lines.join('\n')
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

/**
 * 抽屉里右键的菜单项。
 *
 * 抽屉里**不能**弹主对话的会话菜单：那份菜单作用在会话上（压缩会话、Commit、Fork、
 * 分享链接、Clear），而 btw 是一次独立运行，在它身上点「Clear」会把主会话清掉。
 * 所以菜单只做这条线程自己的事，且都是「拿起这段字」的动作——btw 的用途就是旁问一句、
 * 然后把结论带回主流程。
 *
 * 返回 `{ id, label, title?, disabled?, danger? }` 或 `{ separator: true }`；
 * 图标由组件按 id 映射（纯函数里不该出现组件）。
 */
export function btwContextMenuItems({
  entry = null,
  running = false,
  compacting = false,
  hasEntries = false,
  hasSelection = false,
  canQuote = true,
  canClose = true
} = {}) {
  // 右键落在某一条上时优先拿那一条的正文：回答优先，没有回答（还在跑/出错）就是问题
  const text = String(entry?.answer || entry?.question || '').trim()
  const copyLabel = hasSelection ? '复制选中内容' : entry?.answer ? '复制回答' : '复制问题'
  return [
    {
      id: 'copy',
      label: copyLabel,
      title: hasSelection ? '复制这段选中的文字' : undefined,
      disabled: !hasSelection && !text
    },
    {
      id: 'quote',
      label: '引用到主对话',
      title: '把这段字作为引用块插进主对话的输入框（随后由你决定发不发）',
      disabled: !text || !canQuote
    },
    { separator: true },
    { id: 'new-thread', label: '新话题', title: '开一条新线程，上下文与当前这条互不影响' },
    {
      id: 'compact',
      label: '快速压缩',
      title: '本地压缩这条线程的上下文：不调用模型、不丢轮次，可重复执行',
      disabled: running || compacting || !hasEntries
    },
    {
      id: 'close-thread',
      label: '关闭这个线程',
      title: running ? '正在回答中，答完才能关' : undefined,
      disabled: running || !canClose,
      danger: true
    }
  ]
}
