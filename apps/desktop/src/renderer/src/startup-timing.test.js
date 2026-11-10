import { describe, expect, it } from 'bun:test'
import { createStartupTiming } from './startup-timing.js'

describe('startup timing', () => {
  it('保留首次提交前的阶段，直到探针读取', () => {
    let now = 12.34
    const win = {
      location: { search: '' },
      performance: { now: () => now, getEntriesByType: () => [{ responseEnd: 8.36 }] }
    }
    const timing = createStartupTiming(win)
    timing.mark('main')
    timing.setTime('viewLoaded', 22.22)
    timing.setView('app')
    now = 42.67
    timing.finish()
    timing.finish()
    expect(win.__micaStartupTiming).toEqual({
      main: 12.3,
      viewLoaded: 22.2,
      route: 'app',
      commit: 42.7,
      responseEnd: 8.4
    })
  })

  it('perf=0 不收集启动数据', () => {
    const win = { location: { search: '?perf=0' }, performance: { now: () => 10 } }
    const timing = createStartupTiming(win)
    timing.mark('main')
    timing.finish()
    expect(win.__micaStartupTiming).toBeUndefined()
  })
})
