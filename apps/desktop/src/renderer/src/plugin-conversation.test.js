import { describe, expect, test } from 'bun:test'
import {
  appendConversationDraft,
  conversationStateActivate,
  conversationStateBind,
  conversationStateKey,
  conversationStateWithItem,
  normalizeConversationState,
  isConversationTarget,
  RECENT_CONVERSATION_LIMIT
} from './plugin-conversation.js'

describe('embedded conversation state', () => {
  test('a delayed first-turn binding updates the original node without switching the active conversation', () => {
    let state = conversationStateWithItem(null, { key: 'one', nodeId: 'node-1' })
    state = conversationStateWithItem(state, { key: 'two', nodeId: 'node-2' })
    const bound = conversationStateBind(state, 'node-1', 'session-1', 123)
    expect(bound.activeId).toBe('two')
    expect(bound.items[0]).toMatchObject({ nodeId: 'node-1', sessionId: 'session-1' })
    expect(bound.items[1].sessionId).toBeUndefined()
  })

  test('a slow reference may only append to the still-visible same scope, conversation and node', () => {
    const target = { stateKey: 'scope-a', itemKey: 'one', nodeId: 'n1', visible: true }
    expect(isConversationTarget({ ...target }, target)).toBe(true)
    for (const patch of [
      { visible: false },
      { stateKey: 'scope-b' },
      { itemKey: 'two' },
      { nodeId: 'n2' }
    ]) {
      expect(isConversationTarget({ ...target, ...patch }, target)).toBe(false)
    }
  })
  test('uses a distinct bounded ui-state key for every plugin scope', () => {
    const first = conversationStateKey('schedule', 'item:one')
    const second = conversationStateKey('schedule', 'item:two')
    expect(first).not.toBe(second)
    expect(first.length).toBeLessThanOrEqual(128)
    expect(conversationStateKey('schedule', 'item:one')).toBe(first)
    expect(conversationStateKey('schedule', 'x'.repeat(400)).length).toBeLessThanOrEqual(128)
  })

  test('normalizes malformed state without discarding valid old sessions', () => {
    expect(
      normalizeConversationState({
        activeId: 'missing',
        items: [
          { key: 'one', nodeId: 'node-1', sessionId: 'session-1', title: '一' },
          { key: 'one', nodeId: 'duplicate' },
          { key: '', nodeId: 'ignored' },
          { key: 'two' }
        ]
      })
    ).toEqual({
      version: 1,
      activeId: 'one',
      items: [{ key: 'one', nodeId: 'node-1', sessionId: 'session-1', title: '一' }]
    })
  })

  test('activating and adding a conversation keeps old history entries', () => {
    const first = conversationStateWithItem(null, { key: 'one', nodeId: 'node-1', title: '旧对话' })
    const second = conversationStateWithItem(first, {
      key: 'two',
      nodeId: 'node-2',
      title: '新对话'
    })
    expect(second.activeId).toBe('two')
    expect(second.items.map((item) => item.key)).toEqual(['one', 'two'])
    expect(conversationStateActivate(second, 'one').activeId).toBe('one')
    expect(RECENT_CONVERSATION_LIMIT).toBe(60)
  })

  test('appends reference text to the shared draft without replacing it', () => {
    expect(appendConversationDraft('', '引用')).toBe('引用')
    expect(appendConversationDraft('自己写的', '引用')).toBe('自己写的\n引用')
    expect(appendConversationDraft('自己写的\n', '引用')).toBe('自己写的\n引用')
  })
})
