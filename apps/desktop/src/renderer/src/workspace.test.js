import { describe, expect, it } from 'bun:test'
import {
  COLD_START_NODE_ID,
  createColdStartTerminal,
  normalizeNodes,
  pickReusableDraft
} from './workspace'

const draft = (id, overrides = {}) => ({
  id,
  parent: '#',
  text: '新对话',
  type: 'terminal',
  cwd: '/tmp/a',
  sessionId: null,
  command: null,
  lastActiveAt: 0,
  state: { opened: false, selected: false },
  ...overrides
})

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
    // 固定 id：两个窗口在「运行时里还没有工作区」时同时冷启动会落到同一个节点上
    expect(terminal.id).toBe(COLD_START_NODE_ID)
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

describe('pickReusableDraft', () => {
  it('reuses an empty unbound draft with the same cwd and no group', () => {
    const nodes = [
      draft('term-1'),
      draft('term-2', { cwd: '/tmp/b' }),
      draft('term-bound', { sessionId: 'session-1' })
    ]
    expect(pickReusableDraft(nodes, { cwd: '/tmp/a' })?.id).toBe('term-1')
  })

  it('normalizes trailing slashes when comparing cwd', () => {
    const nodes = [draft('term-1', { cwd: '/tmp/a' })]
    expect(pickReusableDraft(nodes, { cwd: '/tmp/a/' })?.id).toBe('term-1')
  })

  it('does not reuse a draft the user is still typing in', () => {
    const nodes = [draft('term-1')]
    expect(pickReusableDraft(nodes, { cwd: '/tmp/a', drafts: { 'term-1': 'hello' } })).toBe(null)
    // 只敲了空格不算没发出去的内容，仍然可以复用
    expect(pickReusableDraft(nodes, { cwd: '/tmp/a', drafts: { 'term-1': '  \n' } })?.id).toBe(
      'term-1'
    )
  })

  it('does not reuse a draft belonging to another group', () => {
    const nodes = [draft('term-1')]
    expect(pickReusableDraft(nodes, { cwd: '/tmp/a', draftGroups: { 'term-1': 'group-1' } })).toBe(
      null
    )
    expect(
      pickReusableDraft(nodes, {
        cwd: '/tmp/a',
        groupId: 'group-1',
        draftGroups: { 'term-1': 'group-1' }
      })?.id
    ).toBe('term-1')
  })

  it('skips a draft whose turn is already running', () => {
    const nodes = [draft('term-1'), draft('term-2')]
    expect(
      pickReusableDraft(nodes, { cwd: '/tmp/a', isRunning: (id) => id === 'term-1' })?.id
    ).toBe('term-2')
  })

  it('skips a draft reserved by a scheduled loop', () => {
    const nodes = [draft('term-1'), draft('term-2')]
    expect(pickReusableDraft(nodes, { cwd: '/tmp/a', excludedIds: new Set(['term-1']) })?.id).toBe(
      'term-2'
    )
  })
})
