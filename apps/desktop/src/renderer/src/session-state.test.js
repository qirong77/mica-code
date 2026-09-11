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
    expect(liveSessionRowState({})).toBeNull()
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

  it('turns red when the last turn errored, before its result is read', () => {
    expect(
      liveSessionRowState({
        notificationState: { unread: true, running: false, lastType: 'turn.error' }
      })
    ).toBe('error')
    // 读过之后红点仍在：它是会话状态，不是未读徽标。
    expect(
      liveSessionRowState({
        notificationState: { unread: false, running: false, lastType: 'turn.error' }
      })
    ).toBe('error')
  })

  it('keeps a user-requested abort on the unread dot', () => {
    expect(
      liveSessionRowState({
        notificationState: { unread: true, running: false, lastType: 'turn.aborted' }
      })
    ).toBe('unread')
  })

  it('turns red for a session the host marked as interrupted', () => {
    expect(liveSessionRowState({ interrupted: true })).toBe('error')
    // running 只是没跑完的一种，恢复运行后绿点优先。
    expect(liveSessionRowState({ interrupted: true, notificationState: { running: true } })).toBe(
      'running'
    )
    // 红点比同一次事件带来的未读更值得看，不能被蓝色盖掉。
    expect(liveSessionRowState({ interrupted: true, notificationState: { unread: true } })).toBe(
      'error'
    )
  })
})
