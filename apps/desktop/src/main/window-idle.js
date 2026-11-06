/**
 * 隐藏窗口的空闲回收。
 *
 * 关掉终端 / 浏览器窗口只是隐藏：PTY、标签页、登录态都要留着，下次点开还在原处。代价是
 * 隐藏窗口仍然各占一份 renderer（实测 15–75MB）与它在 GPU 进程里的合成缓存——开着不用
 * 一天能攒出十几个隐藏窗口、一两个 GB，而 16GB 机器上 swap 早就用满了。
 *
 * 只收「隐藏」且超过 `idleMs` 没有任何使用的那几个：
 * - 显示中的窗口一律不碰，用户正看着的窗口被收掉就是 bug；
 * - 正在跑页面上操作的窗口由调用方用 `busy` 挡住：一次导航、一张截图可能跑几十秒；
 * - 默认一个不留（`keep = 0`）：时长本身就是保护，收掉一个隐藏窗口只等于下次重开一次；
 * - 收掉的是**壳子**，不是数据：终端会话与滚动内容在运行时那边，重新打开时页面自己接上。
 *   浏览器窗口按其标签页重建，所以它的默认时长比终端长。
 */
export const TERMINAL_IDLE_REAP_MS = 30 * 60 * 1000
export const BROWSER_IDLE_REAP_MS = 60 * 60 * 1000
export const WINDOW_IDLE_SWEEP_MS = 60 * 1000

/** 环境变量读时长：解析不出来用默认值，`0` 表示关掉这条回收（测试与排障用）。 */
export function resolveMs(raw, fallback) {
  const text = String(raw ?? '').trim()
  if (!text) return fallback
  const value = Number.parseInt(text, 10)
  if (!Number.isInteger(value) || value < 0) return fallback
  return value
}

/**
 * 纯判定：给定候选窗口，返回该收掉的 id。
 *
 * `entries` 每项是 `{ id, visible, idleSince, busy }`——`idleSince` 是「从这一刻起没人用」
 * 的时间戳（隐藏的时刻），显示中的窗口给 null。
 */
export function selectIdleWindows(entries, now, { idleMs, keep = 0 } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return []
  if (!(idleMs > 0)) return []
  const hidden = entries.filter(
    (entry) => entry && entry.id != null && !entry.visible && Number.isFinite(entry.idleSince)
  )
  if (hidden.length <= keep) return []
  // 按闲置时长从久到近排；时间戳相同（同一 tick 里建的一批窗口）时保持传入顺序，
  // 于是「最近隐藏的那几个」就是数组末尾那几个——创建顺序是这里唯一可用的先后依据。
  const ordered = hidden
    .slice()
    .sort((left, right) => Number(left.idleSince) - Number(right.idleSince))
  const keepFrom = Math.max(0, ordered.length - keep)
  // 输出按闲置最久的排前面：日志读起来就是「哪个窗口放得最久」。
  return ordered
    .slice(0, keepFrom)
    .filter((entry) => !entry.busy && now - Number(entry.idleSince) >= idleMs)
    .map((entry) => entry.id)
}

/** 每分钟扫一次。`sweepMs <= 0` 时不起定时器，由调用方自己触发（测试用）。 */
export function startIdleReaper(sweep, { sweepMs = WINDOW_IDLE_SWEEP_MS, label = 'window' } = {}) {
  if (typeof sweep !== 'function' || !(sweepMs > 0)) return () => {}
  const timer = setInterval(() => {
    try {
      sweep(Date.now())
    } catch (error) {
      console.error(`[mica-${label}] 隐藏窗口回收失败:`, error)
    }
  }, sweepMs)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** 回收日志：一条一行，带上窗口种类与闲置时长，事后能对上是哪一类窗口堆起来的。 */
export function describeReap(kind, id, idleMs) {
  const minutes = Math.max(1, Math.round(idleMs / 60000))
  return `[mica-${kind}] 回收隐藏窗口 ${id}（闲置 ${minutes} 分钟）`
}
