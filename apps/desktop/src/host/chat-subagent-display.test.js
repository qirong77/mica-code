import { describe, expect, it } from 'bun:test'
import { createSubagentDisplay } from './chat-subagent-display'

describe('subagent display lifecycle', () => {
  it('clears all observed tasks on success without allowing snapshots to revive them', () => {
    const display = createSubagentDisplay()
    const failed = { taskId: 'failed', status: 'failed' }
    const stopped = { taskId: 'stopped', status: 'killed' }
    display.update([failed, stopped])
    display.update([stopped])
    expect(display.finish('turn-1', 'turn-1', 'completed')).toEqual([])
    const fresh = { taskId: 'fresh', status: 'running' }
    expect(display.update([failed, stopped, fresh])).toEqual([fresh])
  })

  it('keeps failures and interruptions, and ignores an old turn completion', () => {
    const display = createSubagentDisplay()
    const task = { taskId: 'task', status: 'failed' }
    display.update([task])
    expect(display.finish('new', 'old', 'completed')).toBeNull()
    expect(display.finish('new', 'new', 'error')).toBeNull()
    expect(display.finish('new', 'new', 'aborted')).toBeNull()
    expect(display.update([task])).toEqual([task])
  })

  it('filters unseen old finished tasks but keeps running and newer or ambiguous tasks', () => {
    const display = createSubagentDisplay()
    const before = Date.now()
    expect(display.finish('turn-1', 'turn-1', 'completed')).toEqual([])
    const old = { taskId: 'old', status: 'failed', finishedAt: new Date(before - 1000).toISOString() }
    const running = { taskId: 'running', status: 'running', finishedAt: old.finishedAt }
    const fresh = { taskId: 'fresh', status: 'failed', finishedAt: new Date(Date.now() + 1000).toISOString() }
    const missing = { taskId: 'missing', status: 'failed' }
    const invalid = { taskId: 'invalid', status: 'failed', finishedAt: 'invalid' }
    expect(display.update([old, running, fresh, missing, invalid])).toEqual([running, fresh, missing, invalid])
  })

  it('does not hide a running task even if its id was observed before success', () => {
    const display = createSubagentDisplay()
    const running = { taskId: 'running', status: 'running' }
    display.update([running])
    display.finish('turn-1', 'turn-1', 'completed')
    expect(display.update([running])).toEqual([running])
    const finished = { ...running, status: 'failed', finishedAt: new Date(Date.now() + 1000).toISOString() }
    expect(display.update([finished])).toEqual([finished])
  })
})
