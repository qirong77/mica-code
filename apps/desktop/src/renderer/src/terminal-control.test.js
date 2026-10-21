import { describe, expect, test } from 'bun:test'
import {
  isTerminalOwnedByNode,
  nodeTerminals,
  terminalIconBadge,
  terminalIconTitle,
  terminalStatusLabel
} from './terminal-control'

const terminal = (overrides = {}) => ({
  id: 'term-1',
  owner: 'session-a',
  label: '终端控制',
  cwd: '/tmp/work',
  cols: 120,
  rows: 32,
  running: true,
  windowVisible: false,
  ...overrides
})

describe('nodeTerminals', () => {
  test('keeps terminals owned by the node id or session id, plus unowned ones', () => {
    const list = [
      terminal({ id: 'a', owner: 'session-a' }),
      terminal({ id: 'b', owner: 'node-1' }),
      terminal({ id: 'c', owner: 'other' }),
      terminal({ id: 'd', owner: null })
    ]
    const result = nodeTerminals(list, { id: 'node-1', sessionId: 'session-a' })
    expect(result.map((item) => item.id)).toEqual(['a', 'b', 'd'])
  })

  test('handles a missing node without throwing', () => {
    const list = [terminal({ id: 'a', owner: 'x' }), terminal({ id: 'b', owner: null })]
    expect(nodeTerminals(list, null).map((item) => item.id)).toEqual(['b'])
  })
})

describe('isTerminalOwnedByNode', () => {
  test('matches either the node id or the session id', () => {
    expect(
      isTerminalOwnedByNode(terminal({ owner: 'session-a' }), { sessionId: 'session-a' })
    ).toBe(true)
    expect(isTerminalOwnedByNode(terminal({ owner: 'node-1' }), { id: 'node-1' })).toBe(true)
    expect(isTerminalOwnedByNode(terminal({ owner: '' }), { id: 'node-1' })).toBe(false)
  })
})

describe('terminal labels', () => {
  test('describes a running, hidden terminal', () => {
    const item = terminal()
    expect(terminalStatusLabel(item)).toBe('后台运行')
    const title = terminalIconTitle(item, { id: 'node-1', sessionId: 'session-a' })
    expect(title).toContain('终端控制')
    expect(title).toContain('/tmp/work')
    expect(title).toContain('120×32')
    expect(title).toContain('点击显示')
    expect(title).not.toContain('未归属')
  })

  test('marks exited and unowned terminals', () => {
    const item = terminal({ running: false, windowVisible: true, owner: 'someone-else' })
    expect(terminalStatusLabel(item)).toBe('已退出')
    const title = terminalIconTitle(item, { id: 'node-1' })
    expect(title).toContain('已退出')
    expect(title).toContain('点击隐藏')
    expect(title).toContain('归属')
  })
})

describe('terminalIconBadge', () => {
  test('numbers icons only when there is more than one terminal', () => {
    const list = [terminal({ id: 'a' }), terminal({ id: 'b' })]
    expect(terminalIconBadge(list, list[0])).toBe('1')
    expect(terminalIconBadge(list, list[1])).toBe('2')
    expect(terminalIconBadge([terminal({ id: 'a' })], { id: 'a' })).toBe('')
    expect(terminalIconBadge(list, { id: 'missing' })).toBe('')
  })
})
