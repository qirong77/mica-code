import { describe, expect, it } from 'vitest'
import { resolvePanelRunId } from './chat-panel-routing.js'

function run(sessionId, writable = true) {
  return {
    sessionId,
    child: { stdin: { writable } }
  }
}

describe('resolvePanelRunId', () => {
  it('reuses a live host from another node in the same session', () => {
    const runs = new Map([
      ['current-node', run('session-1', false)],
      ['session-node', run('session-1')]
    ])

    expect(resolvePanelRunId(runs, 'current-node', 'session-1')).toBe('session-node')
  })

  it('does not reuse a live host from a different session', () => {
    const runs = new Map([['other-session-node', run('session-2')]])

    expect(resolvePanelRunId(runs, 'current-node', 'session-1')).toBe('current-node')
  })

  it('falls back to the requested node when the same-session host is dead', () => {
    const runs = new Map([['dead-session-node', run('session-1', false)]])

    expect(resolvePanelRunId(runs, 'current-node', 'session-1')).toBe('current-node')
  })

  it('keeps the requested node for drafts without a session', () => {
    const runs = new Map([['session-node', run('session-1')]])

    expect(resolvePanelRunId(runs, 'draft-node', '')).toBe('draft-node')
  })
})
