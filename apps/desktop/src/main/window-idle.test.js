import { describe, expect, it } from 'vitest'
import {
  BROWSER_IDLE_REAP_MS,
  TERMINAL_IDLE_REAP_MS,
  WINDOW_IDLE_SWEEP_MS,
  describeReap,
  resolveMs,
  selectIdleWindows,
  startIdleReaper
} from './window-idle'

const MINUTE = 60 * 1000
const NOW = 100 * MINUTE

/** 隐藏了多久（分钟）的窗口；`visible` 的给 null 的 idleSince */
function win(id, idleMinutes, extra = {}) {
  return {
    id,
    visible: idleMinutes === null,
    idleSince: idleMinutes === null ? null : NOW - idleMinutes * MINUTE,
    ...extra
  }
}

describe('selectIdleWindows', () => {
  it('没有候选时返回空', () => {
    expect(selectIdleWindows([], NOW, { idleMs: 30 * MINUTE })).toEqual([])
    expect(selectIdleWindows(null, NOW, { idleMs: 30 * MINUTE })).toEqual([])
  })

  it('显示中的窗口一律不收', () => {
    const entries = [win('a', null), win('b', null)]
    expect(selectIdleWindows(entries, NOW, { idleMs: 30 * MINUTE, keep: 0 })).toEqual([])
  })

  it('没到闲置时长的不收', () => {
    const entries = [win('a', 10), win('b', 29)]
    expect(selectIdleWindows(entries, NOW, { idleMs: 30 * MINUTE, keep: 0 })).toEqual([])
  })

  it('超过闲置时长的收掉，默认一个都不留', () => {
    const entries = [win('a', 90), win('b', 60), win('c', 5)]
    // c 还没到时长，跟 keep 无关
    expect(selectIdleWindows(entries, NOW, { idleMs: 30 * MINUTE })).toEqual(['a', 'b'])
    // 真正的保护是时长本身：刚好到期的也照收
    expect(selectIdleWindows([win('d', 30)], NOW, { idleMs: 30 * MINUTE })).toEqual(['d'])
  })

  it('keep 只保最近的那几个，不看闲置时长', () => {
    const entries = [win('a', 200), win('b', 150), win('c', 100)]
    expect(selectIdleWindows(entries, NOW, { idleMs: 30 * MINUTE, keep: 2 })).toEqual(['a'])
    expect(selectIdleWindows(entries, NOW, { idleMs: 30 * MINUTE, keep: 3 })).toEqual([])
  })

  it('busy 的窗口跳过：正在跑页面操作时不能被当成闲置', () => {
    const entries = [win('a', 90, { busy: true }), win('b', 80), win('c', 1)]
    expect(selectIdleWindows(entries, NOW, { idleMs: 30 * MINUTE })).toEqual(['b'])
  })

  it('idleSince 缺失或非法的条目不动', () => {
    const entries = [
      { id: 'a', visible: false, idleSince: null },
      { id: 'b', visible: false, idleSince: Number.NaN },
      { id: 'c', visible: false },
      win('d', 90),
      win('e', 1)
    ]
    expect(selectIdleWindows(entries, NOW, { idleMs: 30 * MINUTE })).toEqual(['d'])
  })

  it('idleMs 非正数等于关掉这条回收', () => {
    const entries = [win('a', 999), win('b', 999)]
    expect(selectIdleWindows(entries, NOW, { idleMs: 0 })).toEqual([])
    expect(selectIdleWindows(entries, NOW, { idleMs: -1 })).toEqual([])
  })

  it('边界：正好等于闲置时长就算到期', () => {
    const entries = [win('a', 30), win('b', 1)]
    expect(selectIdleWindows(entries, NOW, { idleMs: 30 * MINUTE })).toEqual(['a'])
  })
})

describe('resolveMs', () => {
  it('空值、非数字、负数都用默认值', () => {
    expect(resolveMs(undefined, 7)).toBe(7)
    expect(resolveMs('', 7)).toBe(7)
    expect(resolveMs('   ', 7)).toBe(7)
    expect(resolveMs('abc', 7)).toBe(7)
    expect(resolveMs('-5', 7)).toBe(7)
  })

  it('合法数字照用，0 是「关掉」而不是默认值', () => {
    expect(resolveMs('1800000', 7)).toBe(1800000)
    expect(resolveMs(0, 7)).toBe(0)
    expect(resolveMs('0', 7)).toBe(0)
  })

  it('默认时长：终端比浏览器短（浏览器窗口重建代价更大）', () => {
    expect(TERMINAL_IDLE_REAP_MS).toBe(30 * MINUTE)
    expect(BROWSER_IDLE_REAP_MS).toBe(60 * MINUTE)
    expect(WINDOW_IDLE_SWEEP_MS).toBe(MINUTE)
    expect(BROWSER_IDLE_REAP_MS).toBeGreaterThan(TERMINAL_IDLE_REAP_MS)
  })
})

describe('startIdleReaper', () => {
  it('sweepMs 为 0 或 sweep 不是函数时不起定时器', () => {
    const stop = startIdleReaper(() => {}, { sweepMs: 0 })
    expect(typeof stop).toBe('function')
    stop()
    expect(() => startIdleReaper(null, { sweepMs: 10 })).not.toThrow()
  })

  it('定时触发传入当前时间，sweep 抛错不会让定时器停掉', async () => {
    const calls = []
    let thrown = 0
    const stop = startIdleReaper(
      (now) => {
        calls.push(now)
        if (calls.length === 1) {
          thrown += 1
          throw new Error('boom')
        }
      },
      { sweepMs: 5 }
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    stop()
    expect(calls.length).toBeGreaterThan(1)
    expect(thrown).toBe(1)
    expect(typeof calls[0]).toBe('number')
  })
})

describe('describeReap', () => {
  it('日志里带窗口种类与分钟数', () => {
    expect(describeReap('terminal', 's-1', 45 * MINUTE)).toBe(
      '[mica-terminal] 回收隐藏窗口 s-1（闲置 45 分钟）'
    )
    expect(describeReap('browser', 'brw-2', 30 * 1000)).toContain('闲置 1 分钟')
  })
})
