import { describe, expect, it } from 'bun:test'
import { startPerfProbe } from './perf-probe.js'

// 用假 window 驱动探针：定时器手工触发，避免测试依赖真实时间。
function createHarness({ fetchResult = { ok: true } } = {}) {
  const intervals = new Map()
  const cleared = []
  let seq = 0
  const posted = []
  const elements = Array.from({ length: 123 }, () => ({}))
  const rows = Array.from({ length: 7 }, () => ({}))

  const win = {
    performance: {
      now: () => (seq += 1000),
      memory: { usedJSHeapSize: 4 * 1048576, totalJSHeapSize: 8 * 1048576 }
    },
    setInterval: (fn, ms) => {
      const id = ++seq + ms
      intervals.set(id, { fn, ms })
      return id
    },
    clearInterval: (id) => {
      cleared.push(id)
      intervals.delete(id)
    },
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
  return { win, doc, intervals, cleared, posted, get seq() { return seq } }
}

function tick(harness, ms) {
  for (const { fn, ms: interval } of harness.intervals.values()) {
    if (interval === ms) fn()
  }
}

describe('startPerfProbe', () => {
  it('采样包含 lag/long/dom/rows/heap', () => {
    const harness = createHarness()
    const probe = startPerfProbe(harness.win, harness.doc)
    const [sample] = probe.report()
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

  it('flush 走 perf:report 通道并清空待发样本', async () => {
    const harness = createHarness()
    const probe = startPerfProbe(harness.win, harness.doc)
    tick(harness, 1000)
    expect(probe.report().length).toBe(2)
    await probe.flush()
    expect(harness.posted.length).toBe(1)
    expect(harness.posted[0].url).toBe('/api/invoke')
    expect(harness.posted[0].body.channel).toBe('perf:report')
    expect(harness.posted[0].body.payload.samples.length).toBe(2)
    expect(probe.report().length).toBe(0)
    probe.stop()
  })

  it('落盘失败时样本放回待发，不丢数据', async () => {
    const harness = createHarness({ fetchResult: { ok: false, status: 500 } })
    const probe = startPerfProbe(harness.win, harness.doc)
    tick(harness, 1000)
    await probe.flush()
    expect(probe.report().length).toBe(2)
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
