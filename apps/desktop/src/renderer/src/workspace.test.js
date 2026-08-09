import { describe, expect, it } from 'bun:test'
import { createColdStartTerminal, normalizeNodes } from './workspace'

describe('createColdStartTerminal', () => {
  it('does not restore stale session bindings or resume commands', () => {
    const nodes = normalizeNodes([
      {
        id: 'folder-1',
        parent: '#',
        text: 'project',
        type: 'folder',
        cwd: '/tmp/project'
      },
      {
        id: 'term-old',
        parent: 'folder-1',
        text: 'Old session',
        type: 'terminal',
        sessionId: 'session-old',
        command: 'mica --resume session-old'
      }
    ])

    const terminal = createColdStartTerminal(nodes, 'term-old', 123)

    expect(terminal).toMatchObject({
      parent: '#',
      text: '新对话',
      type: 'terminal',
      cwd: '/tmp/project',
      sessionId: null,
      command: null,
      lastActiveAt: 123,
      state: { opened: false, selected: true }
    })
    expect(terminal.id).not.toBe('term-old')
  })

  it('creates a clean draft when no workspace terminal exists', () => {
    expect(createColdStartTerminal([], null, 456)).toMatchObject({
      text: '新对话',
      cwd: null,
      sessionId: null,
      command: null,
      lastActiveAt: 456
    })
  })
})
