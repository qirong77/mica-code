import { describe, expect, it } from 'bun:test'
import { liveSessionRowState, runningTerminalSessions } from './session-state'

describe('runningTerminalSessions', () => {
  const terms = [
    { id: 'rt-1', sessionId: 's1' },
    { id: 'rt-2', sessionId: 's1' },
    { id: 'rt-3', sessionId: 's2' },
    { id: 'rt-4', sessionId: null }
  ]

  it('marks a session when one of its terminals runs a foreground process', () => {
    expect(runningTerminalSessions(terms, { 'rt-2': { processRunning: true } })).toEqual(
      new Set(['s1'])
    )
  })

  it('ignores agent turns and terminals without an owning session', () => {
    expect(
      runningTerminalSessions(terms, {
        'rt-3': { running: true, agentRunning: true, processRunning: false },
        'rt-4': { processRunning: true }
      })
    ).toEqual(new Set())
  })

  it('drops the mark once the process exits', () => {
    expect(
      runningTerminalSessions([{ id: 'rt-1', sessionId: 's1' }], {
        'rt-1': { processRunning: false }
      })
    ).toEqual(new Set())
  })
})

describe('liveSessionRowState', () => {
  it('only reports activity received from the current app process', () => {
    expect(liveSessionRowState({ persistedTurnState: 'running' })).toBeNull()
    expect(liveSessionRowState({ notificationState: { unread: true, running: false } })).toBe(
      'unread'
    )
    expect(liveSessionRowState({ notificationState: { unread: false, running: true } })).toBe(
      'running'
    )
    expect(liveSessionRowState({ notificationState: { unread: true, running: true } })).toBe(
      'running'
    )
    expect(liveSessionRowState({ notificationState: null })).toBeNull()
  })
})
