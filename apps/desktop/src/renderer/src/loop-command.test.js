import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_LOOP_MINUTES,
  loopBadgeText,
  loopCountdown,
  loopDraftFromInterval,
  loopForNode,
  loopIntervalFromDraft,
  loopNodeIds,
  loopProgressLabel,
  loopSessionIds,
  loopStatusLabel,
  loopTooltip,
  sortLoopsForList
} from './loop-command'

const NOW = 1_700_000_000_000
const MINUTE = 60_000

function loop(overrides = {}) {
  return {
    nodeId: 'node-1',
    sessionId: 'sess-1',
    cwd: '/tmp',
    intervalMs: 30 * MINUTE,
    task: '推送一条 AI 新闻',
    status: 'active',
    startedAt: NOW,
    fireCount: 0,
    lastFireAt: null,
    nextFireAt: NOW + 30 * MINUTE,
    lastError: null,
    ...overrides
  }
}

describe('template constants', () => {
  it('defaults the composer panel to an hour', () => {
    expect(DEFAULT_LOOP_MINUTES).toBe(60)
  })
})

describe('indexing loops', () => {
  const loops = [loop(), loop({ nodeId: 'node-2', sessionId: null })]

  it('finds a loop by node', () => {
    expect(loopForNode(loops, 'node-1')?.sessionId).toBe('sess-1')
    expect(loopForNode(loops, 'nope')).toBeNull()
    expect(loopForNode(null, 'node-1')).toBeNull()
  })

  it('collects session and node ids, skipping drafts in the session index', () => {
    expect([...loopSessionIds(loops)]).toEqual(['sess-1'])
    expect([...loopNodeIds(loops)]).toEqual(['node-1', 'node-2'])
  })
})

describe('sortLoopsForList', () => {
  it('puts running loops first, soonest fire ahead, paused last', () => {
    const late = loop({ nodeId: 'late', nextFireAt: NOW + 60 * MINUTE })
    const soon = loop({ nodeId: 'soon', nextFireAt: NOW + MINUTE })
    const paused = loop({ nodeId: 'paused', status: 'paused', nextFireAt: null })
    expect(sortLoopsForList([paused, late, soon]).map((item) => item.nodeId)).toEqual([
      'soon',
      'late',
      'paused'
    ])
  })

  it('tolerates a null list', () => {
    expect(sortLoopsForList(null)).toEqual([])
  })
})

describe('labels', () => {
  it('distinguishes waiting from running and paused', () => {
    expect(loopStatusLabel(loop())).toBe('等待运行中')
    expect(loopStatusLabel(loop(), true)).toBe('运行中')
    expect(loopStatusLabel(loop({ status: 'paused' }))).toBe('已暂停')
    expect(loopStatusLabel(loop({ status: 'paused' }), true)).toBe('已暂停')
    expect(loopStatusLabel(null)).toBe('')
  })

  it('describes progress', () => {
    expect(loopProgressLabel(loop({ fireCount: 3 }))).toBe('每 30 分钟 · 3 次')
    expect(loopProgressLabel(loop({ intervalMs: 2 * 3_600_000, fireCount: 0 }))).toBe(
      '每 2 小时 · 0 次'
    )
  })

  it('builds the composer badge like the CLI does', () => {
    expect(loopBadgeText(loop({ fireCount: 3, nextFireAt: NOW + 192_000 }), NOW)).toBe(
      '⏰ 每 30 分钟 · 下次 3 分 12 秒 · 第 3 次'
    )
    expect(loopBadgeText(loop({ nextFireAt: NOW + 200 }), NOW)).toContain('下次 即将触发')
    expect(loopBadgeText(loop({ fireCount: 3 }), NOW, true)).toBe(
      '⏰ 每 30 分钟 · 运行中 · 第 3 次'
    )
    expect(loopBadgeText(loop({ status: 'paused', nextFireAt: null }), NOW)).toContain('已暂停')
    expect(loopBadgeText(null, NOW)).toBe('')
  })

  it('counts down in the unit that fits', () => {
    expect(loopCountdown(loop({ nextFireAt: NOW + 30_000 }), NOW)).toBe('30 秒后')
    expect(loopCountdown(loop({ nextFireAt: NOW + 12 * MINUTE }), NOW)).toBe('12 分钟后')
    expect(loopCountdown(loop({ nextFireAt: NOW + 3 * 3_600_000 }), NOW)).toBe('3 小时后')
    expect(loopCountdown(loop({ nextFireAt: NOW + 2 * 86_400_000 }), NOW)).toBe('2 天后')
    expect(loopCountdown(loop({ nextFireAt: NOW - 1 }), NOW)).toBe('即将触发')
  })

  it('reports a paused loop instead of a countdown', () => {
    expect(loopCountdown(loop({ status: 'paused', nextFireAt: null }), NOW)).toBe('已暂停')
    expect(loopCountdown(null, NOW)).toBe('')
  })

  it('spells out the tooltip including the last failure', () => {
    const text = loopTooltip(loop({ fireCount: 2, lastError: '会话正在运行，本次已跳过' }), NOW)
    expect(text).toContain('定时任务：等待运行中')
    expect(text).toContain('间隔：每 30 分钟')
    expect(text).toContain('下次：30 分钟后')
    expect(text).toContain('已执行：2 次')
    expect(text).toContain('内容：推送一条 AI 新闻')
    expect(text).toContain('上次：会话正在运行，本次已跳过')
    expect(loopTooltip(loop(), NOW, true)).toContain('定时任务：运行中')
  })

  it('omits the countdown line for a paused loop', () => {
    expect(loopTooltip(loop({ status: 'paused', nextFireAt: null }), NOW)).not.toContain('下次：')
  })
})

describe('interval form maths', () => {
  it('converts a form value into milliseconds', () => {
    expect(loopIntervalFromDraft({ amount: '60', unit: 'm' })).toEqual({
      ok: true,
      intervalMs: 60 * MINUTE,
      label: '1 小时'
    })
    expect(loopIntervalFromDraft({ amount: '2', unit: 'h' }).intervalMs).toBe(2 * 3_600_000)
    expect(loopIntervalFromDraft({ amount: '1', unit: 'd' }).intervalMs).toBe(86_400_000)
    // 秒是合法单位：10 秒正是下限，面板必须写得出来
    expect(loopIntervalFromDraft({ amount: '10', unit: 's' }).intervalMs).toBe(10_000)
  })

  it('rejects empty, non-positive and out-of-range values', () => {
    expect(loopIntervalFromDraft({ amount: '', unit: 'm' }).ok).toBe(false)
    expect(loopIntervalFromDraft({ amount: '0', unit: 'm' }).ok).toBe(false)
    expect(loopIntervalFromDraft({ amount: '-5', unit: 'm' }).ok).toBe(false)
    expect(loopIntervalFromDraft({ amount: 'abc', unit: 'm' }).ok).toBe(false)
    expect(loopIntervalFromDraft({ amount: '0.05', unit: 'm' }).ok).toBe(false)
    expect(loopIntervalFromDraft({ amount: '8', unit: 'd' }).ok).toBe(false)
    expect(loopIntervalFromDraft({ amount: '5', unit: 's' }).ok).toBe(false)
  })

  it('falls back to the first unit for an unknown one', () => {
    expect(loopIntervalFromDraft({ amount: '30', unit: 'weird' }).intervalMs).toBe(30_000)
  })

  it('round-trips an interval back into the form, preferring the largest unit', () => {
    expect(loopDraftFromInterval(60 * MINUTE)).toEqual({ amount: '1', unit: 'h' })
    expect(loopDraftFromInterval(2 * 86_400_000)).toEqual({ amount: '2', unit: 'd' })
    expect(loopDraftFromInterval(90 * MINUTE)).toEqual({ amount: '90', unit: 'm' })
    // 不足一分钟按秒回填：向上取整成 1 分钟会让回填值与真实间隔不符
    expect(loopDraftFromInterval(10_000)).toEqual({ amount: '10', unit: 's' })
    expect(loopDraftFromInterval(45_000)).toEqual({ amount: '45', unit: 's' })
    expect(loopDraftFromInterval(0)).toEqual({ amount: '60', unit: 'm' })
  })
})
