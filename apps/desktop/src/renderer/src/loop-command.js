/**
 * 定时循环任务在渲染层的纯逻辑（状态文案、倒计时、徽标、表单换算），供侧栏分区、输入框
 * 时钟图标（唯一的创建/管理入口）与输入框边框徽标共用。
 *
 * 循环本身活在运行时里（`src/host/loops.js`），这里只把它的状态翻译成界面要显示的东西，
 * 以及把用户在表单里填的间隔换算成毫秒。
 */
import {
  DEFAULT_LOOP_INTERVAL_MS,
  MAX_LOOP_INTERVAL_MS,
  MIN_LOOP_INTERVAL_MS,
  formatLoopInterval
} from '@packages/mica-common/loopArgs.js'

/** 时钟图标面板里的默认间隔（分钟）。 */
export const DEFAULT_LOOP_MINUTES = 60

export const LOOP_INTERVAL_UNITS = [
  // 秒也要能表达：CLI 支持 `10s`，而 10 秒正是最小间隔，缺了它面板就写不出合法的最短循环，
  // 「等价命令」也会被四舍五入成 1 分钟（不等价）。
  { id: 's', label: '秒', ms: 1_000 },
  { id: 'm', label: '分钟', ms: 60_000 },
  { id: 'h', label: '小时', ms: 3_600_000 },
  { id: 'd', label: '天', ms: 86_400_000 }
]

export const LOOP_INTERVAL_LIMITS = {
  min: MIN_LOOP_INTERVAL_MS,
  max: MAX_LOOP_INTERVAL_MS,
  default: DEFAULT_LOOP_INTERVAL_MS
}

/** 当前节点是否已有循环（无论暂停与否）。 */
export function loopForNode(loops, nodeId) {
  const id = typeof nodeId === 'string' ? nodeId : ''
  if (!id) return null
  return (Array.isArray(loops) ? loops : []).find((loop) => loop?.nodeId === id) || null
}

/** 循环按会话 id 建索引：侧栏需要从会话行反查它是不是定时任务。 */
export function loopSessionIds(loops) {
  const ids = new Set()
  for (const loop of Array.isArray(loops) ? loops : []) {
    if (typeof loop?.sessionId === 'string' && loop.sessionId) ids.add(loop.sessionId)
  }
  return ids
}

/** 循环按 nodeId 建索引：草稿行（还没有 sessionId）用它判断归属。 */
export function loopNodeIds(loops) {
  const ids = new Set()
  for (const loop of Array.isArray(loops) ? loops : []) {
    if (typeof loop?.nodeId === 'string' && loop.nodeId) ids.add(loop.nodeId)
  }
  return ids
}

/**
 * 侧栏列表顺序：进行中的在前（按最近到期），暂停的垫后（按最近更新）。
 * 返回原数组元素，不改写对象。
 */
export function sortLoopsForList(loops) {
  const list = Array.isArray(loops) ? [...loops] : []
  return list.sort((a, b) => {
    const activeA = a?.status === 'active' ? 0 : 1
    const activeB = b?.status === 'active' ? 0 : 1
    if (activeA !== activeB) return activeA - activeB
    if (activeA === 0) {
      const nextA = Number.isFinite(a?.nextFireAt) ? a.nextFireAt : Infinity
      const nextB = Number.isFinite(b?.nextFireAt) ? b.nextFireAt : Infinity
      if (nextA !== nextB) return nextA - nextB
    }
    return (Number(b?.startedAt) || 0) - (Number(a?.startedAt) || 0)
  })
}

/**
 * 状态文案。定时任务是输入框时钟面板控制的常驻任务，`active` 下还要区分「这一轮正在跑」
 * 与「在等下一次触发」——侧栏与会话面板都要能一眼看出它此刻到底有没有在动。
 */
export function loopStatusLabel(loop, running = false) {
  if (!loop) return ''
  if (loop.status !== 'active') return '已暂停'
  return running ? '运行中' : '等待运行中'
}

/** 距离下一次触发的短文案（秒级刷新用）。 */
export function loopCountdown(loop, now = Date.now()) {
  if (!loop) return ''
  if (loop.status !== 'active') return '已暂停'
  if (!Number.isFinite(loop.nextFireAt)) return ''
  const diff = loop.nextFireAt - now
  if (diff <= 0) return '即将触发'
  const seconds = Math.round(diff / 1_000)
  if (seconds < 60) return `${seconds} 秒后`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟后`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时后`
  return `${Math.round(hours / 24)} 天后`
}

/** 秒级精度的倒计时，与 CLI 的 `formatCountdown` 同款文案（`3 分 12 秒`）。 */
function countdownText(nextFireAt, now) {
  const diff = Number(nextFireAt) - now
  if (!Number.isFinite(diff)) return ''
  if (diff < 1_000) return '即将触发'
  const totalSeconds = Math.ceil(diff / 1_000)
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes > 0 ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}

/**
 * 会话输入框上的常驻徽标，与 CLI 的 `buildLoopBadge` 同形：`⏰ 每 30 分钟 · 下次 3 分 12 秒 · 第 3 次`。
 * 一轮正在跑时用「运行中」顶掉倒计时——数着秒等一个已经开始的轮次没有意义。
 */
export function loopBadgeText(loop, now = Date.now(), running = false) {
  if (!loop) return ''
  const head = `⏰ 每 ${formatLoopInterval(loop.intervalMs)}`
  const count = `第 ${loop.fireCount || 0} 次`
  if (loop.status !== 'active') return `${head} · 已暂停 · ${count}`
  if (running) return `${head} · 运行中 · ${count}`
  return `${head} · 下次 ${countdownText(loop.nextFireAt, now)} · ${count}`
}

/** 行尾进度：`每 30 分钟 · 3 次`。 */
export function loopProgressLabel(loop) {
  if (!loop) return ''
  return `每 ${formatLoopInterval(loop.intervalMs)} · ${loop.fireCount || 0} 次`
}

/** 鼠标悬停的完整说明：状态、间隔、倒计时、任务内容与最近一次失败原因。 */
export function loopTooltip(loop, now = Date.now(), running = false) {
  if (!loop) return ''
  const lines = [
    `定时任务：${loopStatusLabel(loop, running)}`,
    `间隔：每 ${formatLoopInterval(loop.intervalMs)}`
  ]
  if (loop.status === 'active') lines.push(`下次：${loopCountdown(loop, now)}`)
  lines.push(`已执行：${loop.fireCount || 0} 次`)
  lines.push(`内容：${loop.task}`)
  if (loop.lastError) lines.push(`上次：${loop.lastError}`)
  return lines.join('\n')
}

/**
 * 表单（数字 + 单位）换算成毫秒；越界或非数字返回 `{ ok: false, error }`。
 * 上限取一周，避免 `setTimeout` 溢出。
 */
export function loopIntervalFromDraft({ amount, unit } = {}) {
  const value = Number(String(amount ?? '').trim())
  if (!Number.isFinite(value) || value <= 0) return { ok: false, error: '请填写大于 0 的间隔' }
  const found = LOOP_INTERVAL_UNITS.find((item) => item.id === unit) || LOOP_INTERVAL_UNITS[0]
  const ms = Math.round(value * found.ms)
  if (ms < MIN_LOOP_INTERVAL_MS) return { ok: false, error: '间隔最短 10 秒' }
  if (ms > MAX_LOOP_INTERVAL_MS) return { ok: false, error: '间隔最长一周' }
  return { ok: true, intervalMs: ms, label: formatLoopInterval(ms) }
}

/** 已有循环的间隔回填到表单：取最大的整数单位，`90 分钟` → `{ amount: '90', unit: 'm' }`。 */
export function loopDraftFromInterval(intervalMs) {
  const ms = Number(intervalMs)
  if (!Number.isFinite(ms) || ms <= 0) {
    return { amount: String(DEFAULT_LOOP_MINUTES), unit: 'm' }
  }
  const days = ms / 86_400_000
  if (Number.isInteger(days) && days >= 1) return { amount: String(days), unit: 'd' }
  const hours = ms / 3_600_000
  if (Number.isInteger(hours) && hours >= 1) return { amount: String(hours), unit: 'h' }
  const minutes = ms / 60_000
  if (Number.isInteger(minutes) && minutes >= 1) return { amount: String(minutes), unit: 'm' }
  // 不足一分钟（10s～59s）：按秒回填，否则会四舍五入成 1 分钟、与真实间隔不符
  const seconds = Math.max(1, Math.round(ms / 1_000))
  return { amount: String(seconds), unit: 's' }
}

export { formatLoopInterval }
