import { describe, expect, it } from 'bun:test'
import {
  createScheduledTask,
  DEFAULT_RUNS,
  dueTasks,
  emptyScheduled,
  intervalMinutesToMs,
  nextDueAt,
  normalizeScheduled,
  normalizeTotalRuns,
  recordTaskRun,
  recordTaskSkip,
  removeScheduledTask,
  removeTasksForSession,
  updateScheduledTask
} from './scheduled-tasks'

const NOW = 1_700_000_000_000

function makeTask(overrides = {}) {
  const result = createScheduledTask(
    emptyScheduled(),
    {
      id: 't1',
      title: '会话标题',
      prompt: '继续推进',
      sessionId: 's1',
      nodeId: 'n1',
      intervalMinutes: 5,
      totalRuns: 3,
      ...overrides
    },
    { now: NOW }
  )
  return result
}

describe('normalizeTotalRuns', () => {
  it('treats empty / zero / negative as unlimited', () => {
    expect(normalizeTotalRuns('')).toBe(0)
    expect(normalizeTotalRuns(0)).toBe(0)
    expect(normalizeTotalRuns(-3)).toBe(0)
    expect(normalizeTotalRuns(undefined)).toBe(0)
  })

  it('floors positive numbers without an upper bound', () => {
    expect(normalizeTotalRuns(7.9)).toBe(7)
    expect(normalizeTotalRuns('12')).toBe(12)
    expect(normalizeTotalRuns(5_000_000)).toBe(1_000_000)
  })
})

describe('intervalMinutesToMs', () => {
  it('accepts 1..10080 minutes', () => {
    expect(intervalMinutesToMs(1)).toBe(60_000)
    expect(intervalMinutesToMs('30')).toBe(30 * 60_000)
    expect(intervalMinutesToMs(10080)).toBe(10080 * 60_000)
  })

  it('rejects out of range and junk', () => {
    expect(intervalMinutesToMs(0)).toBe(0)
    expect(intervalMinutesToMs(10081)).toBe(0)
    expect(intervalMinutesToMs('abc')).toBe(0)
  })
})

describe('createScheduledTask', () => {
  it('creates an active task defaulting to 10 runs and 5 minutes', () => {
    const result = createScheduledTask(
      emptyScheduled(),
      { id: 'a', prompt: '跑一下', sessionId: 's1' },
      { now: NOW }
    )
    expect(result.ok).toBe(true)
    expect(result.task.totalRuns).toBe(DEFAULT_RUNS)
    expect(result.task.intervalMs).toBe(5 * 60_000)
    expect(result.task.nextRunAt).toBe(NOW + 5 * 60_000)
    expect(result.task.title).toBe('跑一下')
    expect(result.scheduled.tasks).toHaveLength(1)
  })

  it('derives the title from the first non-empty line and keeps the full prompt', () => {
    const result = createScheduledTask(
      emptyScheduled(),
      { id: 'a', prompt: '\n\n  第一行  \n第二行', sessionId: 's1' },
      { now: NOW }
    )
    expect(result.task.title).toBe('第一行')
    expect(result.task.prompt).toBe('第一行  \n第二行')
  })

  it('refuses empty prompts, missing sessions and bad intervals', () => {
    expect(createScheduledTask(emptyScheduled(), { id: 'a', prompt: '  ' }).error).toContain(
      '先输入'
    )
    expect(
      createScheduledTask(emptyScheduled(), { id: 'a', prompt: 'x', sessionId: '' }).error
    ).toContain('关联会话')
    expect(
      createScheduledTask(emptyScheduled(), {
        id: 'a',
        prompt: 'x',
        sessionId: 's1',
        intervalMinutes: 0
      }).error
    ).toContain('间隔')
  })
})

describe('updateScheduledTask', () => {
  it('reschedules when the interval changes', () => {
    const { scheduled, task } = makeTask()
    const result = updateScheduledTask(
      scheduled,
      task.id,
      { intervalMinutes: 30 },
      { now: NOW + 1000 }
    )
    expect(result.ok).toBe(true)
    expect(result.task.intervalMs).toBe(30 * 60_000)
    expect(result.task.nextRunAt).toBe(NOW + 1000 + 30 * 60_000)
  })

  it('pauses without a next run and resumes from now', () => {
    const { scheduled, task } = makeTask()
    const paused = updateScheduledTask(scheduled, task.id, { status: 'paused' }, { now: NOW + 10 })
    expect(paused.task.status).toBe('paused')
    expect(paused.task.nextRunAt).toBeNull()
    const resumed = updateScheduledTask(
      paused.scheduled,
      task.id,
      { status: 'active' },
      {
        now: NOW + 20
      }
    )
    expect(resumed.task.status).toBe('active')
    expect(resumed.task.nextRunAt).toBe(NOW + 20 + 5 * 60_000)
  })

  it('raises the total again for an exhausted task', () => {
    const { scheduled, task } = makeTask({ totalRuns: 1 })
    const done = recordTaskRun(scheduled, task.id, { at: NOW + 60_000 })
    expect(done.tasks[0].status).toBe('completed')
    expect(done.tasks[0].nextRunAt).toBeNull()
    const revived = updateScheduledTask(done, task.id, { totalRuns: 5 }, { now: NOW + 120_000 })
    expect(revived.task.status).toBe('active')
    expect(revived.task.runs).toBe(1)
    expect(revived.task.nextRunAt).toBe(NOW + 120_000 + 5 * 60_000)
  })
})

describe('recordTaskRun / recordTaskSkip', () => {
  it('counts a run and schedules the next one', () => {
    const { scheduled, task } = makeTask()
    const next = recordTaskRun(scheduled, task.id, { at: NOW + 60_000 })
    expect(next.tasks[0].runs).toBe(1)
    expect(next.tasks[0].lastRunAt).toBe(NOW + 60_000)
    expect(next.tasks[0].nextRunAt).toBe(NOW + 60_000 + 5 * 60_000)
    expect(next.tasks[0].status).toBe('active')
  })

  it('completes the task when the quota is used up', () => {
    const { scheduled, task } = makeTask({ totalRuns: 2 })
    const first = recordTaskRun(scheduled, task.id, { at: NOW })
    const second = recordTaskRun(first, task.id, { at: NOW + 1000 })
    expect(second.tasks[0].runs).toBe(2)
    expect(second.tasks[0].status).toBe('completed')
    expect(second.tasks[0].nextRunAt).toBeNull()
  })

  it('never runs out of quota when unlimited', () => {
    const { scheduled, task } = makeTask({ totalRuns: '' })
    let next = scheduled
    for (let index = 0; index < 12; index += 1) {
      next = recordTaskRun(next, task.id, { at: NOW + index * 1000 })
    }
    expect(next.tasks[0].runs).toBe(12)
    expect(next.tasks[0].status).toBe('active')
  })

  it('a skip keeps the counter and only pushes the next run back', () => {
    const { scheduled, task } = makeTask()
    const next = recordTaskSkip(scheduled, task.id, { at: NOW, error: '会话正在运行' })
    expect(next.tasks[0].runs).toBe(0)
    expect(next.tasks[0].lastError).toBe('会话正在运行')
    expect(next.tasks[0].nextRunAt).toBe(NOW + 5 * 60_000)
  })
})

describe('dueTasks / nextDueAt', () => {
  it('picks only active tasks whose time has come, earliest first', () => {
    const a = makeTask({ id: 'a', sessionId: 's1' })
    const b = createScheduledTask(
      a.scheduled,
      {
        id: 'b',
        prompt: 'x',
        sessionId: 's2',
        intervalMinutes: 1
      },
      { now: NOW }
    )
    const paused = updateScheduledTask(b.scheduled, 'a', { status: 'paused' }, { now: NOW })
    expect(dueTasks(paused.scheduled, NOW).map((task) => task.id)).toEqual([])
    expect(dueTasks(paused.scheduled, NOW + 60_000).map((task) => task.id)).toEqual(['b'])
    expect(nextDueAt(paused.scheduled)).toBe(NOW + 60_000)
    expect(nextDueAt(emptyScheduled())).toBeNull()
  })
})

describe('normalizeScheduled', () => {
  it('drops junk entries and re-derives inconsistent status', () => {
    const normalized = normalizeScheduled({
      tasks: [
        { id: 'a', prompt: 'x', sessionId: 's1', intervalMs: 60_000, totalRuns: 2, runs: 5 },
        { id: 'a', prompt: 'dupe', sessionId: 's1', intervalMs: 60_000 },
        { id: '', prompt: 'x', sessionId: 's1', intervalMs: 60_000 },
        { id: 'b', prompt: '', sessionId: 's1', intervalMs: 60_000 },
        { id: 'c', prompt: 'x', sessionId: '', intervalMs: 60_000 },
        { id: 'd', prompt: 'x', sessionId: 's1', intervalMs: 1 },
        { id: 'e', prompt: 'x', sessionId: 's1', intervalMs: 60_000, status: 'weird' }
      ]
    })
    expect(normalized.tasks.map((task) => task.id)).toEqual(['a', 'e'])
    expect(normalized.tasks[0].status).toBe('completed')
    expect(normalized.tasks[0].nextRunAt).toBeNull()
    expect(normalized.tasks[1].status).toBe('active')
  })
})

describe('removal helpers', () => {
  it('removes one task by id', () => {
    const { scheduled } = makeTask()
    expect(removeScheduledTask(scheduled, 't1').tasks).toHaveLength(0)
    expect(removeScheduledTask(scheduled, 'nope').tasks).toHaveLength(1)
  })

  it('removes every task bound to a session', () => {
    const one = makeTask()
    const two = createScheduledTask(
      one.scheduled,
      { id: 't2', prompt: 'x', sessionId: 's2', intervalMinutes: 5 },
      { now: NOW }
    )
    expect(removeTasksForSession(two.scheduled, 's1').tasks.map((task) => task.id)).toEqual(['t2'])
    expect(removeTasksForSession(two.scheduled, '').tasks).toHaveLength(2)
  })
})
