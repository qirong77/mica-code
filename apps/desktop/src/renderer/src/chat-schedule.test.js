import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_RUNS,
  countdownLabel,
  formatIntervalMinutes,
  parseScheduleDraft,
  sortTasksForList,
  taskProgress,
  taskStatusLabel,
  tasksOfSession
} from './chat-schedule'

const NOW = 1_700_000_000_000

function task(overrides = {}) {
  return {
    id: 't1',
    title: '标题',
    prompt: '继续',
    sessionId: 's1',
    nodeId: 'n1',
    intervalMs: 5 * 60_000,
    totalRuns: 10,
    runs: 3,
    status: 'active',
    createdAt: NOW,
    nextRunAt: NOW + 5 * 60_000,
    lastRunAt: null,
    lastError: null,
    ...overrides
  }
}

describe('parseScheduleDraft', () => {
  it('accepts whole minutes and positive counts', () => {
    expect(parseScheduleDraft({ intervalMinutes: '5', runs: '10' })).toEqual({
      ok: true,
      intervalMinutes: 5,
      totalRuns: 10
    })
  })

  it('treats an empty count as unlimited', () => {
    expect(parseScheduleDraft({ intervalMinutes: 30, runs: '' })).toEqual({
      ok: true,
      intervalMinutes: 30,
      totalRuns: 0
    })
  })

  it('rejects out-of-range intervals and junk counts', () => {
    expect(parseScheduleDraft({ intervalMinutes: '0' }).ok).toBe(false)
    expect(parseScheduleDraft({ intervalMinutes: '10081' }).ok).toBe(false)
    expect(parseScheduleDraft({ intervalMinutes: 'abc' }).ok).toBe(false)
    expect(parseScheduleDraft({ intervalMinutes: '5', runs: 'many' }).ok).toBe(false)
  })

  it('does not cap the count (需求里的「无上限」)', () => {
    expect(parseScheduleDraft({ intervalMinutes: '5', runs: '99999' }).totalRuns).toBe(99999)
  })

  it('defaults match the host defaults', () => {
    expect(DEFAULT_RUNS).toBe(10)
  })
})

describe('formatIntervalMinutes', () => {
  it('uses hours and days for round values', () => {
    expect(formatIntervalMinutes(5)).toBe('5 分钟')
    expect(formatIntervalMinutes(60)).toBe('1 小时')
    expect(formatIntervalMinutes(90)).toBe('90 分钟')
    expect(formatIntervalMinutes(1440)).toBe('1 天')
  })
})

describe('taskProgress / taskStatusLabel', () => {
  it('shows the quota as runs/total, or 不限 when unlimited', () => {
    expect(taskProgress(task())).toBe('3/10')
    expect(taskProgress(task({ totalRuns: 0 }))).toBe('3/不限')
  })

  it('maps status to Chinese labels', () => {
    expect(taskStatusLabel(task())).toBe('进行中')
    expect(taskStatusLabel(task({ status: 'paused' }))).toBe('已暂停')
    expect(taskStatusLabel(task({ status: 'completed' }))).toBe('已完成')
  })
})

describe('countdownLabel', () => {
  it('renders seconds, minutes and hours ahead', () => {
    expect(countdownLabel(NOW + 30_000, NOW)).toBe('30 秒后')
    expect(countdownLabel(NOW + 4 * 60_000, NOW)).toBe('4 分钟后')
    expect(countdownLabel(NOW + 2 * 3_600_000, NOW)).toBe('2 小时后')
  })

  it('is empty without a next run and switches to 即将触发 when due', () => {
    expect(countdownLabel(null, NOW)).toBe('')
    expect(countdownLabel(NOW - 5000, NOW)).toBe('即将触发')
  })
})

describe('tasksOfSession', () => {
  it('matches by session once bound', () => {
    const tasks = [task(), task({ id: 't2', sessionId: 's2', nodeId: 'n9' })]
    expect(tasksOfSession(tasks, { sessionId: 's1', nodeId: 'n1' }).map((item) => item.id)).toEqual(
      ['t1']
    )
  })

  it('falls back to the node id while the session is not bound', () => {
    const tasks = [task(), task({ id: 't2', sessionId: 's2', nodeId: 'n2' })]
    expect(tasksOfSession(tasks, { sessionId: null, nodeId: 'n2' }).map((item) => item.id)).toEqual(
      ['t2']
    )
  })
})

describe('sortTasksForList', () => {
  it('keeps active tasks first by next run, then the rest by recency', () => {
    const list = sortTasksForList([
      task({ id: 'done', status: 'completed', createdAt: NOW + 3 }),
      task({ id: 'paused', status: 'paused', createdAt: NOW + 2 }),
      task({ id: 'later', nextRunAt: NOW + 600_000 }),
      task({ id: 'sooner', nextRunAt: NOW + 60_000 })
    ])
    // 进行中按最近到期在前，暂停/完成垫后并按创建时间倒序（暂停比完成更值得看）
    expect(list.map((item) => item.id)).toEqual(['sooner', 'later', 'paused', 'done'])
  })
})
