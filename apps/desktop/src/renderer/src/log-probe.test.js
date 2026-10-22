import { describe, expect, it } from 'bun:test'
import { startLogProbe } from './log-probe.js'

function createHarness() {
  const intervals = new Map()
  const listeners = new Map()
  const posted = []
  let seq = 0
  const consoleCalls = []
  const win = {
    setInterval: (fn, ms) => {
      const id = ++seq
      intervals.set(id, { fn, ms })
      return id
    },
    clearInterval: (id) => intervals.delete(id),
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) || []), fn]),
    removeEventListener: (type, fn) =>
      listeners.set(
        type,
        (listeners.get(type) || []).filter((item) => item !== fn)
      ),
    console: {
      error: (...args) => consoleCalls.push(['error', args]),
      warn: (...args) => consoleCalls.push(['warn', args])
    },
    async fetch(url, options) {
      posted.push({ url, body: JSON.parse(options.body) })
      return { ok: true }
    }
  }
  return {
    win,
    intervals,
    listeners,
    posted,
    consoleCalls,
    emit(type, event) {
      for (const fn of listeners.get(type) || []) fn(event)
    },
    tick(ms) {
      for (const { fn, ms: interval } of intervals.values()) if (interval === ms) fn()
    }
  }
}

describe('startLogProbe', () => {
  it('console.error 仍输出到控制台，同时进日志队列', async () => {
    const harness = createHarness()
    const probe = startLogProbe(harness.win)
    harness.win.console.error('boom', 'detail')
    expect(harness.consoleCalls.length).toBe(1)
    expect(harness.consoleCalls[0][1]).toEqual(['boom', 'detail'])
    expect(probe.report().length).toBe(1)
    expect(probe.report()[0].level).toBe('error')
    expect(probe.report()[0].event).toContain('boom')
    probe.stop()
  })

  it('console.warn 记为 warn 级', () => {
    const harness = createHarness()
    const probe = startLogProbe(harness.win)
    harness.win.console.warn('careful')
    expect(probe.report()[0].level).toBe('warn')
    probe.stop()
  })

  it('同样消息在去重窗口内只记一次', () => {
    const harness = createHarness()
    const probe = startLogProbe(harness.win)
    harness.win.console.error('same')
    harness.win.console.error('same')
    harness.win.console.error('same')
    expect(probe.report().length).toBe(1)
    probe.stop()
  })

  it('未捕获异常会记 error 并带队栈', async () => {
    const harness = createHarness()
    const probe = startLogProbe(harness.win)
    const error = new Error('render failed')
    harness.emit('error', { message: 'render failed', error })
    await Promise.resolve()
    expect(harness.posted.length).toBe(1)
    const [entry] = harness.posted[0].body.payload.entries
    expect(entry.level).toBe('error')
    expect(entry.source).toBe('window.error')
    expect(entry.stack).toContain('render failed')
    probe.stop()
  })

  it('promise 拒绝也进日志', async () => {
    const harness = createHarness()
    const probe = startLogProbe(harness.win)
    harness.emit('unhandledrejection', { reason: new Error('nope') })
    await Promise.resolve()
    expect(harness.posted.length).toBe(1)
    const [entry] = harness.posted[0].body.payload.entries
    expect(entry.level).toBe('error')
    expect(entry.source).toBe('unhandledrejection')
    probe.stop()
  })

  it('定时 flush 推到 log:report 通道后清空', async () => {
    const harness = createHarness()
    const probe = startLogProbe(harness.win)
    harness.win.console.error('one')
    harness.tick(5000)
    await Promise.resolve()
    expect(harness.posted.length).toBe(1)
    expect(harness.posted[0].url).toBe('/api/invoke')
    expect(harness.posted[0].body.channel).toBe('log:report')
    expect(harness.posted[0].body.payload.scope).toBe('renderer')
    expect(probe.report().length).toBe(0)
    probe.stop()
  })

  it('推送失败时留在队列里重试', async () => {
    const harness = createHarness()
    harness.win.fetch = async () => ({ ok: false, status: 500 })
    const probe = startLogProbe(harness.win)
    harness.win.console.error('keep me')
    await probe.flush()
    expect(probe.report().length).toBe(1)
    probe.stop()
  })

  it('stop 还原 console 并移除监听', () => {
    const harness = createHarness()
    const original = harness.win.console.error
    const probe = startLogProbe(harness.win)
    expect(harness.win.console.error).not.toBe(original)
    expect(harness.listeners.get('error')?.length).toBe(1)
    probe.stop()
    expect(harness.win.console.error).toBe(original)
    expect(harness.listeners.get('error')?.length).toBe(0)
    expect(harness.win.__micaLog).toBeUndefined()
  })
})
