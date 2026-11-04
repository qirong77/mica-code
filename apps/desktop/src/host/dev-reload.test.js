import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { STAMP_VERSION } from './build-stamp'
import { createDevReload } from './dev-reload'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function stamp({ renderer = 1, cli = 1, runtime = 1, shell = 1 } = {}) {
  return {
    version: STAMP_VERSION,
    builtAt: `2026-11-01T00:00:0${renderer}.000Z`,
    artifacts: {
      renderer: { path: '/r/index.html', size: renderer, mtimeMs: renderer },
      cli: { path: '/cli/mica', size: cli, mtimeMs: cli },
      runtime: { path: '/s/index.mjs', size: runtime, mtimeMs: runtime },
      shell: { path: '/m/index.js', size: shell, mtimeMs: shell }
    }
  }
}

const dirs = []
function harness({ countdownMs = 0, busyWaitMs = 50, tickMs = 5, reloadPulseMs = 400 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mica-devreload-'))
  dirs.push(dir)
  const stampPath = join(dir, 'dev-build-stamp.json')
  writeFileSync(stampPath, JSON.stringify(stamp()))
  const events = []
  const drained = []
  const restarted = []
  let busy = 0
  const reload = createDevReload({
    stampPath,
    broadcast: (channel, payload) => events.push({ channel, payload }),
    hasBusyHosts: () => busy,
    drainHosts: async ({ deadlineMs }) => {
      drained.push(deadlineMs)
      return { recycled: ['node-1'], forced: [] }
    },
    onReadyToRestart: (level) => restarted.push(level),
    countdownMs,
    busyWaitMs,
    tickMs,
    reloadPulseMs
  })
  reload.start()
  return {
    dir,
    stampPath,
    reload,
    events,
    drained,
    restarted,
    setBusy: (value) => {
      busy = value
    },
    build(next) {
      writeFileSync(stampPath, JSON.stringify(next))
      return reload.refresh()
    },
    phases: () =>
      events.filter((event) => event.channel === 'dev:reload').map((event) => event.payload.phase)
  }
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true })
})

describe('createDevReload', () => {
  it('启动时把手上那份产物当基线，不会立刻重载', () => {
    const h = harness()
    expect(h.reload.state().phase).toBe('idle')
    h.reload.stop()
  })

  it('只改界面：倒计时后让页面重载，一个会话宿主都不动', async () => {
    const h = harness()
    h.build(stamp({ renderer: 2 }))
    expect(h.reload.state().phase).toBe('countdown')
    await sleep(60)
    expect(h.reload.state().phase).toBe('reload')
    expect(h.drained).toEqual([])
    expect(h.phases()).toContain('reload')
    // 刷新是一次性脉冲：脉冲窗口过了必须回到 idle，否则每个新挂载的页面都会再刷一次。
    await sleep(520)
    expect(h.reload.state().phase).toBe('idle')
    h.reload.stop()
  })

  it('CLI 变了：先软停，再回收宿主，然后重载页面', async () => {
    const h = harness()
    h.setBusy(1)
    h.build(stamp({ cli: 2 }))
    // 倒计时一结束就动手：软停会等到预算用尽再中断，不再有「等你手动确认」的
    // 半路停靠点——这一轮已经注定被换掉，续跑是自动的。
    await sleep(60)
    expect(h.drained).toHaveLength(1)
    expect(h.reload.state().phase).toBe('reload')
    h.reload.stop()
  })

  it('软停预算原样交给 drainHosts（默认 15s）', async () => {
    const h = harness({ busyWaitMs: 20 })
    h.setBusy(1)
    h.build(stamp({ cli: 2 }))
    await sleep(80)
    expect(h.drained).toEqual([20])
    h.reload.stop()
  })

  it('手动「立即重载」跳过倒计时与等待', async () => {
    const h = harness({ countdownMs: 60000, busyWaitMs: 60000 })
    h.setBusy(1)
    h.build(stamp({ cli: 2 }))
    expect(h.reload.state().phase).toBe('countdown')
    h.reload.act('now')
    h.setBusy(0)
    await sleep(60)
    expect(h.reload.state().phase).toBe('reload')
    h.reload.stop()
  })

  it('「稍后」把这一份构建丢掉，下一次构建才再触发', async () => {
    const h = harness({ countdownMs: 60000 })
    h.build(stamp({ renderer: 2 }))
    h.reload.act('later')
    expect(h.reload.state().phase).toBe('idle')
    // 同一份 stamp 不再触发
    expect(h.reload.refresh()).toBe(null)
    h.build(stamp({ renderer: 3 }))
    expect(h.reload.state().phase).toBe('countdown')
    h.reload.stop()
  })

  it('运行时 / 外壳变了交给外壳自己重启，运行时不自作主张', async () => {
    const h = harness()
    h.build(stamp({ shell: 2 }))
    await sleep(60)
    expect(h.restarted).toEqual(['shell'])
    expect(h.reload.state().phase).toBe('restart')
    h.reload.stop()
  })

  it('stop() 之后不再响应', async () => {
    const h = harness({ countdownMs: 0 })
    h.reload.stop()
    h.build(stamp({ renderer: 2 }))
    await sleep(30)
    expect(h.reload.state().phase).toBe('idle')
  })
})
