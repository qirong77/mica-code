// 渲染层性能探针。只在 `?perf=1` 的页面启用，采样落盘到 userData/perf/*.jsonl。
//
// 采的三类指标对应「卡」的三种成因：
// - lag：定时器实际间隔 vs 预期，直接反映主线程被占住多久（卡顿最直接的证据）
// - long：PerformanceObserver 的 longtask（>50ms 的任务块）与最长一次
// - heap/dom/rows：堆大小、DOM 节点数、对话行数，用来判断「是不是会话太长」
//
// 探针自身开销：一个 1s 定时器 + 一个 15s 的批量 POST，空闲时 CPU 上测不出来。
const INVOKE = '/api/invoke'
const SAMPLE_MS = 1000
const FLUSH_MS = 15000
const MAX_PENDING = 600

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

  // longtask 拿不到归属细节没关系，关键是「这一秒里主线程被占了多少次」。
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
    if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING)
  }

  const sample = () => {
    const now = win.performance.now()
    // 上一轮定时器本该在 SAMPLE_MS 后触发；多出来的就是主线程被占住的时间。
    const lag = now - lastAt - SAMPLE_MS
    lastAt = now
    const stats = domStats(doc)
    push({
      lag: round(lag),
      long: round(longMax),
      longN: longCount,
      ...stats,
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
    try {
      const response = await win.fetch(INVOKE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: 'perf:report', payload: { samples } })
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch {
      // 写失败就把样本放回去，下一轮再试（探针不能因为落盘失败而丢数据）
      pending.unshift(...samples)
      if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING)
    }
  }

  timer = win.setInterval(sample, SAMPLE_MS)
  flushTimer = win.setInterval(flush, FLUSH_MS)

  const api = {
    version: 'perf-1',
    report: () => pending.slice(),
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
