import { describe, expect, it } from 'bun:test'
import { switchChatDraft } from './ChatView'

describe('chat drafts', () => {
  it('keeps unsent text when switching away from and back to a new session', () => {
    const drafts = new Map()

    expect(switchChatDraft(drafts, null, 'new-session', '')).toBe('')
    expect(switchChatDraft(drafts, 'new-session', 'existing-session', 'xxx')).toBe('')
    expect(switchChatDraft(drafts, 'existing-session', 'new-session', '')).toBe('xxx')
  })

  it('does not replace the current input when the same node is restored again', () => {
    const drafts = new Map([['new-session', 'stale']])

    expect(switchChatDraft(drafts, 'new-session', 'new-session', 'latest')).toBe('latest')
  })
})
