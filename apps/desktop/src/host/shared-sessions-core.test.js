import { describe, expect, it } from 'bun:test'
import {
  MAX_SHARED_SESSIONS,
  addSharedSession,
  emptySharedSessions,
  findSharedSession,
  isValidSharedSessionId,
  normalizeSharedSessions,
  removeSharedSession
} from './shared-sessions-core'

const NOW = 1_700_000_000_000

describe('normalizeSharedSessions', () => {
  it('falls back to an empty list for missing or garbage input', () => {
    expect(normalizeSharedSessions(null)).toEqual(emptySharedSessions())
    expect(normalizeSharedSessions({ entries: 'nope' })).toEqual(emptySharedSessions())
    expect(normalizeSharedSessions({ entries: [null, 42, {}, { sessionId: '' }] })).toEqual(
      emptySharedSessions()
    )
  })

  it('drops entries with an unusable session id', () => {
    const state = normalizeSharedSessions({
      entries: [
        { sessionId: '20261014T091017Z-69crfc', sharedAt: NOW },
        { sessionId: '../../etc/passwd', sharedAt: NOW },
        { sessionId: 'has space', sharedAt: NOW },
        { sessionId: '', sharedAt: NOW }
      ]
    })
    expect(state.entries).toEqual([{ sessionId: '20261014T091017Z-69crfc', sharedAt: NOW }])
  })

  it('keeps the newest record per session and sorts by share time', () => {
    const state = normalizeSharedSessions({
      entries: [
        { sessionId: 'a', sharedAt: NOW - 5000 },
        { sessionId: 'b', sharedAt: NOW - 1000 },
        { sessionId: 'a', sharedAt: NOW }
      ]
    })
    expect(state.entries).toEqual([
      { sessionId: 'a', sharedAt: NOW },
      { sessionId: 'b', sharedAt: NOW - 1000 }
    ])
  })

  it('caps the list length', () => {
    const entries = Array.from({ length: MAX_SHARED_SESSIONS + 20 }, (_value, index) => ({
      sessionId: `s-${index}`,
      sharedAt: NOW - index
    }))
    expect(normalizeSharedSessions({ entries }).entries).toHaveLength(MAX_SHARED_SESSIONS)
  })

  it('treats a missing sharedAt as unknown instead of throwing', () => {
    expect(normalizeSharedSessions({ entries: [{ sessionId: 'a' }] }).entries).toEqual([
      { sessionId: 'a', sharedAt: 0 }
    ])
  })
})

describe('addSharedSession', () => {
  it('rejects invalid session ids', () => {
    expect(addSharedSession(emptySharedSessions(), '../x', NOW).ok).toBe(false)
    expect(addSharedSession(emptySharedSessions(), null, NOW).ok).toBe(false)
  })

  it('puts the newest share first and refreshes a repeat share', () => {
    const first = addSharedSession(emptySharedSessions(), 'a', NOW - 1000)
    const second = addSharedSession(first.state, 'b', NOW)
    expect(second.state.entries.map((entry) => entry.sessionId)).toEqual(['b', 'a'])
    const again = addSharedSession(second.state, 'a', NOW + 1000)
    expect(again.state.entries).toEqual([
      { sessionId: 'a', sharedAt: NOW + 1000 },
      { sessionId: 'b', sharedAt: NOW }
    ])
  })
})

describe('removeSharedSession', () => {
  it('reports whether anything was removed', () => {
    const state = addSharedSession(emptySharedSessions(), 'a', NOW).state
    expect(removeSharedSession(state, 'a').state.entries).toEqual([])
    expect(removeSharedSession(state, 'a').ok).toBe(true)
    expect(removeSharedSession(state, 'missing').ok).toBe(false)
  })
})

describe('findSharedSession / isValidSharedSessionId', () => {
  it('finds a registered session', () => {
    const state = addSharedSession(emptySharedSessions(), 'a', NOW).state
    expect(findSharedSession(state, 'a')).toEqual({ sessionId: 'a', sharedAt: NOW })
    expect(findSharedSession(state, 'b')).toBeNull()
  })

  it('accepts the ids session store actually writes', () => {
    expect(isValidSharedSessionId('20261014T091017Z-69crfc')).toBe(true)
    expect(isValidSharedSessionId('0784d7c6-e5a3-4d3f-9d0d-4d1c8ba0bb1f')).toBe(true)
    expect(isValidSharedSessionId('a/b')).toBe(false)
  })
})
