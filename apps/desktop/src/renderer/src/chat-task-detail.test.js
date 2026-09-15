import { describe, expect, it } from 'bun:test'
import {
  backgroundTaskStatusLabel,
  buildSubagentTimeline,
  formatBytes,
  isBackgroundTaskRunning,
  isSubagentRunning,
  subagentStatusLabel,
  taskElapsedMs,
  taskOutputWindowLabel
} from './chat-task-detail'

describe('formatBytes', () => {
  it('formats bytes, kilobytes and megabytes with the documented decimals', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1258)).toBe('1.2 KB')
    expect(formatBytes(10 * 1024)).toBe('10 KB')
    expect(formatBytes(3.4 * 1024 * 1024)).toBe('3.4 MB')
  })

  it('falls back to 0 B for missing or invalid values', () => {
    expect(formatBytes(undefined)).toBe('0 B')
    expect(formatBytes(null)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes('abc')).toBe('0 B')
  })
})

describe('status labels', () => {
  it('maps known subagent statuses and passes unknown ones through', () => {
    expect(subagentStatusLabel('running')).toBe('运行中')
    expect(subagentStatusLabel('completed')).toBe('已完成')
    expect(subagentStatusLabel('failed')).toBe('失败')
    expect(subagentStatusLabel('killed')).toBe('已停止')
    expect(subagentStatusLabel('weird')).toBe('weird')
  })

  it('maps known background task statuses and passes unknown ones through', () => {
    expect(backgroundTaskStatusLabel('starting')).toBe('启动中')
    expect(backgroundTaskStatusLabel('running')).toBe('运行中')
    expect(backgroundTaskStatusLabel('finished')).toBe('已完成')
    expect(backgroundTaskStatusLabel('killed')).toBe('已终止')
    expect(backgroundTaskStatusLabel('failed')).toBe('失败')
    expect(backgroundTaskStatusLabel('unknown_exited')).toBe('异常退出')
    expect(backgroundTaskStatusLabel('weird')).toBe('weird')
  })
})

describe('running detectors', () => {
  it('treats only running subagents as live', () => {
    expect(isSubagentRunning({ status: 'running' })).toBe(true)
    expect(isSubagentRunning({ status: 'completed' })).toBe(false)
    expect(isSubagentRunning(null)).toBe(false)
  })

  it('treats starting and running background tasks as live', () => {
    expect(isBackgroundTaskRunning({ status: 'starting' })).toBe(true)
    expect(isBackgroundTaskRunning({ status: 'running' })).toBe(true)
    expect(isBackgroundTaskRunning({ status: 'finished' })).toBe(false)
    expect(isBackgroundTaskRunning(undefined)).toBe(false)
  })
})

describe('buildSubagentTimeline', () => {
  it('tolerates a missing or non-array timeline', () => {
    expect(buildSubagentTimeline({})).toEqual([])
    expect(buildSubagentTimeline({ timeline: 'nope' })).toEqual([])
    expect(buildSubagentTimeline(null)).toEqual([])
  })

  it('keeps text steps and drops entries without text', () => {
    const steps = buildSubagentTimeline({
      timeline: [
        { id: 'a', kind: 'thinking', text: '想想' },
        { id: 'b', kind: 'text', text: '   ' },
        { id: 'c', kind: 'tool', text: '{"x":1}', toolName: 'read_file' },
        { id: 'd', kind: 'tool_result', text: 'ok', toolName: 'read_file' }
      ]
    })
    expect(steps.map((step) => step.key)).toEqual(['a:0', 'c:2', 'd:3'])
    expect(steps[1]).toEqual({ key: 'c:2', kind: 'tool', text: '{"x":1}', toolName: 'read_file' })
  })

  it('falls back to the index for keys and to thinking for unknown kinds', () => {
    const steps = buildSubagentTimeline({
      timeline: [
        { kind: 'mystery', text: 'hi' },
        { kind: 'text', text: 'yo' }
      ]
    })
    expect(steps[0].key).toBe('0:0')
    expect(steps[0].kind).toBe('thinking')
    expect(steps[1]).toEqual({ key: '1:1', kind: 'text', text: 'yo', toolName: '' })
  })
})

describe('taskOutputWindowLabel', () => {
  it('shows the total when the whole output is present', () => {
    expect(taskOutputWindowLabel({ start: 0, end: 5 * 1024 * 1024, size: 5 * 1024 * 1024 })).toBe(
      '共 5.0 MB'
    )
    expect(taskOutputWindowLabel({})).toBe('共 0 B')
  })

  it('shows the tail window when the output was truncated', () => {
    const size = 5 * 1024 * 1024
    expect(taskOutputWindowLabel({ start: size - 3.4 * 1024 * 1024, end: size, size })).toBe(
      '已显示末尾 3.4 MB / 共 5.0 MB'
    )
  })
})

describe('taskElapsedMs', () => {
  const startedAt = new Date(1000).toISOString()

  it('measures against now while running and against finishedAt once done', () => {
    expect(taskElapsedMs({ startedAt }, 4000)).toBe(3000)
    expect(taskElapsedMs({ startedAt, finishedAt: new Date(2500).toISOString() }, 9999)).toBe(1500)
  })

  it('returns null without a usable start time', () => {
    expect(taskElapsedMs({}, 1)).toBe(null)
    expect(taskElapsedMs(null, 1)).toBe(null)
  })
})
