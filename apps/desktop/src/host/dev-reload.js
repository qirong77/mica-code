/**
 * 「构建完成后自动重载」的状态机。
 *
 * 触发是 `build-stamp.js` 那份指纹，动作分三层（见该文件的注释）。这里只负责**节奏**：
 *
 *   检测到新构建 → 倒计时（页面顶部那条提示）→ 软停正在跑的轮次 → 回收会话宿主 → 应用
 *
 * 两条硬约束决定了这个顺序：
 * - **软停，而不是掐断**：倒计时结束后先请每一轮在下一个迭代边界停下（工具批次已落定、
 *   下一次请求还没发），那段历史是完整的，新宿主直接接着跑。给了 `busyWaitMs`（15s）
 *   的预算；到期还没停（模型正在吐字 / 工具正在跑）才中断——那时这一批工具会被记成
 *   interrupted，续跑时模型重跑它们，所以只有预算真的用尽才走到这一步。
 * - **界面优先**：只改了渲染层时页面 reload 就够，一个宿主都不用动。这条路径最常用，
 *   所以放在最前面短路掉其余动作。
 *
 * 依赖全部注入（`broadcast` / `hasBusyHosts` / `recycleHosts` / `onReadyToRestart`），
 * 因此这一整套节奏可以在单测里用假时钟跑完，不需要真的起 Electron。
 */
import { watch } from 'fs'
import { basename, dirname } from 'path'
import { classifyBuildChange, readBuildStamp } from './build-stamp'

export const DEFAULT_COUNTDOWN_MS = 5000
export const DEFAULT_BUSY_WAIT_MS = 15000
const DEBOUNCE_MS = 300
const POLL_MS = 1500
/**
 * `reload` 是一次性脉冲，不是常驻状态：页面收到就刷新，刷完再问必须是 idle。
 * 留成常驻的话，每个新挂载的页面都会再刷一次——变成一个刷不完的循环。
 */
const RELOAD_PULSE_MS = 1500

export function createDevReload({
  stampPath,
  broadcast = () => {},
  hasBusyHosts = () => 0,
  drainHosts = async () => ({ recycled: [], forced: [] }),
  onReadyToRestart = () => {},
  countdownMs = DEFAULT_COUNTDOWN_MS,
  busyWaitMs = DEFAULT_BUSY_WAIT_MS,
  tickMs = 500,
  reloadPulseMs = RELOAD_PULSE_MS,
  now = () => Date.now(),
  logger = null
}) {
  let baseline = null
  let cycle = null
  let watcher = null
  let pollTimer = null
  let tickTimer = null
  let debounceTimer = null
  let stopped = false

  function log(message, data) {
    try {
      logger?.(message, data)
    } catch {
      // 日志不该影响重载
    }
  }

  function publish() {
    broadcast('dev:reload', state())
  }

  function state() {
    if (!cycle) {
      return { phase: 'idle', level: null, changed: [], remainingMs: 0, busyHosts: hasBusyHosts() }
    }
    const remainingMs = cycle.endsAt ? Math.max(0, cycle.endsAt - now()) : 0
    return {
      phase: cycle.phase,
      level: cycle.level,
      changed: cycle.changed,
      remainingMs,
      busyHosts: hasBusyHosts(),
      builtAt: cycle.builtAt,
      // 软停阶段：正在等各轮次走到迭代边界（最多 `busyWaitMs`）。这段时间界面照常
      // 可用，页面上那条提示说的是「正在等这一轮停下」。
      draining: cycle.phase === 'draining'
    }
  }

  /** 读一次 stamp，变化够大就开一轮。`force` 用于手动触发。 */
  function refresh({ force = false } = {}) {
    if (stopped) return null
    const next = readBuildStamp(stampPath)
    if (!next) return null
    const { level, changed } = classifyBuildChange(baseline, next)
    if (!level && !force) {
      baseline = next
      return null
    }
    if (!level && force) return null
    baseline = next
    begin({ level, changed, builtAt: next.builtAt })
    return state()
  }

  function begin({ level, changed, builtAt }) {
    if (cycle && (cycle.phase === 'applying' || cycle.phase === 'restart')) {
      // 上一轮已经动手了，再来一次等新实例起来之后自己会发现。
      log('dev-reload:busy-cycle-ignored', { level })
      return
    }
    cycle = {
      phase: 'countdown',
      level,
      changed,
      builtAt,
      endsAt: now() + countdownMs,
      busyExpired: false
    }
    log('dev-reload:detected', { level, changed })
    publish()
    ensureTicker()
  }

  function ensureTicker() {
    if (tickTimer) return
    tickTimer = setInterval(tick, tickMs)
    tickTimer.unref?.()
  }

  function clearTicker() {
    if (!tickTimer) return
    clearInterval(tickTimer)
    tickTimer = null
  }

  async function tick() {
    if (!cycle) {
      clearTicker()
      return
    }
    if (cycle.phase === 'countdown') {
      if (now() < cycle.endsAt) {
        publish()
        return
      }
      // 倒计时结束就动手：软停失败也只会等到预算用尽再中断，不再有「等你手动确认」
      // 的半路停靠点——那一轮已经注定要被换掉。
      cycle.phase = 'draining'
      publish()
      void apply()
      return
    }
    if (cycle.phase === 'draining') publish()
  }

  async function apply() {
    if (!cycle) return
    cycle.phase = 'applying'
    publish()
    // 只有界面变了时宿主一个都不用动：这是最常用的那条路径。
    if (cycle.changed.some((layer) => layer !== 'renderer')) {
      try {
        const result = await drainHosts({ deadlineMs: busyWaitMs })
        log('dev-reload:hosts-recycled', result)
      } catch (error) {
        log('dev-reload:drain-failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    const level = cycle.level
    if (level === 'runtime' || level === 'shell') {
      cycle.phase = 'restart'
      publish()
      try {
        onReadyToRestart(level)
      } catch (error) {
        log('dev-reload:restart-failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
      return
    }
    cycle.phase = 'reload'
    publish()
    setTimeout(() => {
      if (!cycle || cycle.phase !== 'reload') return
      cycle = null
      clearTicker()
      publish()
    }, reloadPulseMs).unref?.()
  }

  function act(action) {
    if (action === 'now') {
      if (
        !cycle ||
        cycle.phase === 'applying' ||
        cycle.phase === 'restart' ||
        cycle.phase === 'reload' ||
        cycle.phase === 'draining'
      ) {
        return state()
      }
      cycle.endsAt = now()
      publish()
      void tick()
      return state()
    }
    if (action === 'later') {
      // 「稍后」＝这一份构建先不要了：把基线推到最新，下次构建才会再触发。
      if (
        cycle &&
        cycle.phase !== 'applying' &&
        cycle.phase !== 'reload' &&
        cycle.phase !== 'restart'
      ) {
        cycle = null
        clearTicker()
        publish()
      }
      return state()
    }
    return state()
  }

  function start() {
    baseline = readBuildStamp(stampPath)
    if (baseline) log('dev-reload:stamp-baseline', { builtAt: baseline.builtAt })
    try {
      watcher = watch(dirname(stampPath), (_event, file) => {
        if (file && basename(String(file)) !== basename(stampPath)) return
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          debounceTimer = null
          refresh()
        }, DEBOUNCE_MS)
        debounceTimer.unref?.()
      })
      watcher.on('error', () => {
        // 目录被删掉（重新打包时很常见）时退回轮询。
        watcher?.close?.()
        watcher = null
      })
      watcher.unref?.()
    } catch (error) {
      log('dev-reload:watch-failed', {
        error: error instanceof Error ? error.message : String(error)
      })
    }
    // 目录整体被替换（打包会先删再建）时 watch 会失效，轮询兜底。
    pollTimer = setInterval(() => refresh(), POLL_MS)
    pollTimer.unref?.()
    return state()
  }

  function stop() {
    stopped = true
    clearTicker()
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = null
    watcher?.close?.()
    watcher = null
  }

  return { start, stop, state, act, refresh }
}
