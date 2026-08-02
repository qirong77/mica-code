import { describe, expect, it } from 'bun:test'
import { liveSessionRowState } from './session-state'

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
