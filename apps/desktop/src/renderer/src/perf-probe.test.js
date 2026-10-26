import { describe, expect, it } from 'bun:test'
import { startPerfProbe } from './perf-probe.js'

// 用假 window 驱动探针：时钟与定时器都手工触发，避免测试依赖真实时间。
function createHarness({ fetchResult = { ok: true }, memory = true } = {}) {
  const intervals = new Map()
  const cleared = []
  const listeners = new Map()
  const posted = []
  let seq = 0
  const clock = { now: 0 }
  const elements = Array.from({ length: 123 }, () => ({}))
  const rows = Array.from({ length: 7 }, () => ({}))

  const win = {
    performance: {
      now: () => clock.now,
      ...(memory ? { memory: { usedJSHeapSize: 4 * 1048576, totalJSHeapSize: 8 * 1048576 } } : {})
    },
    setInterval: (fn, ms) => {
      const id = ++seq
      intervals.set(id, { fn, ms })
      return id
    },
    clearInterval: (id) => {
      cleared.push(id)
      intervals.delete(id)
    },
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) || []), fn]),
    removeEventListener: (type, fn) =>
      listeners.set(
        type,
        (listeners.get(type) || []).filter((item) => item !== fn)
      ),
    async fetch(url, options) {
      posted.push({ url, body: JSON.parse(options.body) })
      return fetchResult
    }
  }
  const doc = {
    visibilityState: 'visible',
    getElementsByTagName: () => elements,
    querySelectorAll: () => rows
  }
  return {
    win,
    doc,
    clock,
    intervals,
    cleared,
    listeners,
    posted,
    advance(ms) {
      clock.now += ms
    },
    tick(ms) {
      for (const { fn, ms: interval } of intervals.values()) if (interval === ms) fn()
    },
    emit(type, event) {
      for (const fn of listeners.get(type) || []) fn(event)
    }
  }
}

const sampleOf = (probe) => probe.report().at(-1)

describe('startPerfProbe', () => {
  it('采样包含 lag/long/dom/rows/heap', () => {
    const harness = createHarness()
    const probe = startPerfProbe(harness.win, harness.doc)
    const sample = sampleOf(probe)
    expect(sample.dom).toBe(123)
    expect(sample.rows).toBe(7)
    expect(sample.heapMB).toBe(4)
    expect(sample.vis).toBe(1)
    expect(typeof sample.lag).toBe('number')
    probe.stop()
  })

  it('多注册一次返回同一个探针，不会叠两个定时器', () => {
    const harness = createHarness()
    const first = startPerfProbe(harness.win, harness.doc)
    const size = harness.intervals.size
    const second = startPerfProbe(harness.win, harness.doc)
    expect(second).toBe(first)
    expect(harness.intervals.size).toBe(size)
    first.stop()
  })

  it('空闲时也全量落盘，不做筛选', async () => {
    const harness = createHarness()
    const probe = startPerfProbe(harness.win, harness.doc)
    harness.advance(1000)
    harness.tick(1000)
    expect(probe.report().length).toBe(2)
    harness.tick(15000)
    await Promise.resolve()
    expect(harness.posted.length).toBe(1)
    expect(harness.posted[0].url).toBe('/api/invoke')
    expect(harness.posted[0].body.channel).toBe('perf:report')
    expect(harness.posted[0].body.payload.samples.length).toBe(2)
    expect(harness.posted[0].body.payload.mode).toBe('all')
    // 落盘成功后清空，下一批从零开始
    expect(probe.report().length).toBe(0)
    probe.stop()
  })

  it('卡顿也能原样记录（lag 数值随采样带入）', async () => {
    const harness = createHarness()
    const probe = startPerfProbe(harness.win, harness.doc)
    harness.advance(3000) // 主线程被占住，定时器晚到 2s
    harness.tick(1000)
    const last = sampleOf(probe)
    expect(last.lag).toBe(2000)
    probe.stop()
  })

  it('隐藏窗口不记 lag（定时器被节流，算出来全是几十秒的假冻结）', async () => {
    const harness = createHarness()
    const probe = startPerfProbe(harness.win, harness.doc)
    harness.doc.visibilityState = 'hidden'
    harness.advance(59_000)
    harness.tick(1000)
    expect(sampleOf(probe).lag).toBe(null)
    expect(sampleOf(probe).vis).toBe(0)
    probe.stop()
  })

  it('重新可见时重置基准，不把隐藏期间的时间算进第一帧', async () => {
    const harness = createHarness()
    const probe = startPerfProbe(harness.win, harness.doc)
    harness.doc.visibilityState = 'hidden'
    harness.advance(600_000)
    harness.tick(1000)
    harness.doc.visibilityState = 'visible'
    harness.emit('visibilitychange', {})
    harness.advance(1000)
    harness.tick(1000)
    const last = sampleOf(probe)
    expect(last.vis).toBe(1)
    expect(last.lag).toBe(0)
    probe.stop()
  })

  it('snapshot 会立刻落盘', async () => {
    const harness = createHarness()
    const probe = startPerfProbe(harness.win, harness.doc)
    await probe.snapshot()
    expect(harness.posted.length).toBe(1)
    probe.stop()
  })

  it('落盘失败时样本放回待发，不丢数据', async () => {
    const harness = createHarness({ fetchResult: { ok: false, status: 500 } })
    const probe = startPerfProbe(harness.win, harness.doc)
    await probe.flush()
    expect(probe.report().length).toBe(1)
    probe.stop()
  })

  it('缓存上限 300 点，超出后丢弃最旧的并计数', async () => {
    const harness = createHarness()
    const probe = startPerfProbe(harness.win, harness.doc)
    harness.win.fetch = async (url, options) => {
      harness.posted.push({ url, body: JSON.parse(options.body) })
      return { ok: false, status: 500 }
    }
    for (let i = 0; i < 320; i += 1) {
      harness.advance(1000)
      harness.tick(1000)
    }
    expect(probe.report().length).toBe(300)
    await probe.flush()
    expect(harness.posted.at(-1).body.payload.dropped).toBeGreaterThan(0)
    probe.stop()
  })

  it('stop 清掉定时器与全局引用', () => {
    const harness = createHarness()
    const probe = startPerfProbe(harness.win, harness.doc)
    expect(typeof harness.win.__micaPerf).toBe('object')
    probe.stop()
    expect(harness.cleared.length).toBe(2)
    expect(harness.win.__micaPerf).toBeUndefined()
  })
})
