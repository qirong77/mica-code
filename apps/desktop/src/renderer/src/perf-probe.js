// 渲染层性能探针：每秒采一个点，每 15 秒整批落到系统 temp（开机自动清空）。
//
// 为什么不筛选：只记录"异常"会漏掉用户主观觉得卡、但没越过阈值的时刻，
// 也拿不到卡顿之前的前文。全量记录的成本是每 15 秒一次本地 append，
// 写的是 tmpdir，不用维护保留策略。
//
// 采的三类指标对应"卡"的三种成因：
// - lag：定时器实际间隔 vs 预期，直接反映主线程被占住多久（卡顿最直接的证据）
// - long：PerformanceObserver 的 longtask（>50ms 的任务块）与最长一次
// - heap/dom/rows：堆大小、DOM 节点数、对话行数，用来判断"是不是会话太长"
//
// 错误采集在 log-probe.js（scope=renderer），这里只负责计时，避免两处重复记录。
const INVOKE = '/api/invoke'
const SAMPLE_MS = 1000
const FLUSH_MS = 15000
// 内存里最多攒 5 分钟（300 点）；写盘失败时不丢，攒到下轮重试。
const MAX_PENDING = 300
// DOM 规模变化慢，每 5 秒量一次就够；长会话里 querySelectorAll 不能每秒跑。
const DOM_STATS_EVERY = 5

function round(value, digits = 1) {
  const factor = 10 ** digits
  return Number.isFinite(value) ? Math.round(value * factor) / factor : null
}

function domStats(doc) {
  const rows = doc.querySelectorAll('.chat-transcript > *')
  return {
    dom: doc.getElementsByTagName('*').length,
    rows: rows.length
  }
}

function heapStats(win) {
  const memory = win.performance?.memory
  if (!memory) return null
  return {
    heapMB: round(memory.usedJSHeapSize / 1048576, 1),
    heapTotalMB: round(memory.totalJSHeapSize / 1048576, 1)
  }
}

/**
 * @param {object} win
 * @param {object} doc
 */
export function startPerfProbe(win, doc) {
  if (!win || !doc || win.__micaPerf) return win?.__micaPerf || null

  const pending = []
  let stopLongTask = null
  let timer = null
  let flushTimer = null
  let stopped = false
  let lastAt = win.performance.now()
  let longCount = 0
  let longMax = 0
  let dropped = 0
  let domStatsCache = { dom: 0, rows: 0 }
  let domTick = DOM_STATS_EVERY

  // longtask 拿不到归属细节没关系，关键是"这一秒里主线程被占了多少次"。
  if (typeof win.PerformanceObserver === 'function') {
    try {
      const observer = new win.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longCount += 1
          if (entry.duration > longMax) longMax = entry.duration
        }
      })
      observer.observe({ entryTypes: ['longtask'] })
      stopLongTask = () => observer.disconnect()
    } catch {
      // 浏览器不支持 longtask：只靠 lag 也能判断卡顿
    }
  }

  const push = (sample) => {
    pending.push(sample)
    if (pending.length > MAX_PENDING) {
      pending.splice(0, pending.length - MAX_PENDING)
      dropped += 1
    }
  }

  const sample = () => {
    const now = win.performance.now()
    // 上一轮定时器本该在 SAMPLE_MS 后触发；多出来的就是主线程被占住的时间。
    const lag = now - lastAt - SAMPLE_MS
    lastAt = now
    // 只在需要时量 DOM，其余采样复用上次结果
    if (domTick >= DOM_STATS_EVERY) {
      domStatsCache = domStats(doc)
      domTick = 0
    }
    domTick += 1
    push({
      lag: round(lag),
      long: round(longMax),
      longN: longCount,
      ...domStatsCache,
      ...(heapStats(win) || {}),
      vis: doc.visibilityState === 'visible' ? 1 : 0
    })
    // longtask 计数按窗口统计，别累加成全局总量
    longCount = 0
    longMax = 0
  }

  const flush = async () => {
    if (pending.length === 0 || stopped) return
    const samples = pending.splice(0, pending.length)
    const tailDropped = dropped
    dropped = 0
    try {
      const response = await win.fetch(INVOKE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          channel: 'perf:report',
          payload: { samples, mode: 'all', dropped: tailDropped }
        })
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch {
      // 写失败就把样本放回去，下一轮再试（探针不能因为落盘失败而丢数据）
      pending.unshift(...samples)
      dropped += tailDropped
      if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING)
    }
  }

  timer = win.setInterval(sample, SAMPLE_MS)
  flushTimer = win.setInterval(flush, FLUSH_MS)

  const api = {
    version: 'perf-2',
    report: () => pending.slice(),
    /** 立刻落盘当前缓存（人工排查时用，比如"刚才卡了一下"马上取现场）。 */
    snapshot: flush,
    flush,
    stop: () => {
      stopped = true
      if (timer) win.clearInterval(timer)
      if (flushTimer) win.clearInterval(flushTimer)
      stopLongTask?.()
      if (win.__micaPerf === api) delete win.__micaPerf
    }
  }
  win.__micaPerf = api
  sample()
  return api
}
