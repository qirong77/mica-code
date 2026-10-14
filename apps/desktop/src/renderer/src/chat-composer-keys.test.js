import { describe, expect, it } from 'bun:test'
import { resolveComposerTabAction } from './ChatView'

describe('composer Tab / Shift+Tab action', () => {
  it('queues the current input with Tab while the agent is running', () => {
    expect(resolveComposerTabAction({ shiftKey: false, queueReady: true })).toBe('queue')
  })

  it('queues the current input with Shift+Tab while the agent is running', () => {
    expect(resolveComposerTabAction({ shiftKey: true, queueReady: true })).toBe('queue')
  })

  it('opens the role picker with idle Shift+Tab, matching the CLI role cycling', () => {
    expect(resolveComposerTabAction({ shiftKey: true, queueReady: false })).toBe('cycle-role')
  })

  it('lets a plain idle Tab fall through to the browser default', () => {
    expect(resolveComposerTabAction({ shiftKey: false, queueReady: false })).toBeNull()
  })
})
