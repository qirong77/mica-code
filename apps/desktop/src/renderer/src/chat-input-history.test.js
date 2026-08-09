import { describe, expect, it } from 'bun:test'
import { isCaretOnFirstLine, isCaretOnLastLine, navigateChatHistory } from './ChatView'

function makeCursor() {
  return { current: -1 }
}

const HISTORY = ['a', 'b', 'c'] // c 为最新一条

describe('chat input history navigation', () => {
  it('saves unsent draft on the first ArrowUp and restores it when scrolling back down', () => {
    const drafts = new Map()
    const cursor = makeCursor()
    // 输入 'unsent' 后按 ArrowUp -> 进入历史，最新一条 'c'
    expect(navigateChatHistory(drafts, HISTORY, cursor, -1, 'unsent', 'node')).toBe('c')
    expect(drafts.get('node')).toBe('unsent')
    // 继续往上翻到最旧
    expect(navigateChatHistory(drafts, HISTORY, cursor, -1, 'c', 'node')).toBe('b')
    expect(navigateChatHistory(drafts, HISTORY, cursor, -1, 'b', 'node')).toBe('a')
    expect(navigateChatHistory(drafts, HISTORY, cursor, -1, 'a', 'node')).toBe('a') // 停留最旧
    // 往下翻回最新
    expect(navigateChatHistory(drafts, HISTORY, cursor, 1, 'a', 'node')).toBe('b')
    expect(navigateChatHistory(drafts, HISTORY, cursor, 1, 'b', 'node')).toBe('c')
    // 越过最新 -> 恢复进入历史前的未发送输入
    expect(navigateChatHistory(drafts, HISTORY, cursor, 1, 'c', 'node')).toBe('unsent')
    // draft 不应被浏览过程覆盖
    expect(drafts.get('node')).toBe('unsent')
  })

  it('browsing history does not clobber the saved draft', () => {
    const drafts = new Map()
    const cursor = makeCursor()
    navigateChatHistory(drafts, HISTORY, cursor, -1, 'draft-value', 'node')
    // 浏览若干条后 draft 仍保持原始输入
    navigateChatHistory(drafts, HISTORY, cursor, -1, 'c', 'node')
    navigateChatHistory(drafts, HISTORY, cursor, -1, 'b', 'node')
    expect(drafts.get('node')).toBe('draft-value')
    expect(navigateChatHistory(drafts, HISTORY, cursor, 1, 'a', 'node')).toBe('b')
    expect(navigateChatHistory(drafts, HISTORY, cursor, 1, 'b', 'node')).toBe('c')
    expect(navigateChatHistory(drafts, HISTORY, cursor, 1, 'c', 'node')).toBe('draft-value')
  })

  it('ArrowDown at the draft position is a no-op', () => {
    const drafts = new Map()
    const cursor = makeCursor()
    expect(navigateChatHistory(drafts, HISTORY, cursor, 1, 'hello', 'node')).toBe(null)
    expect(drafts.has('node')).toBe(false)
  })

  it('empty history is a no-op', () => {
    const drafts = new Map()
    const cursor = makeCursor()
    expect(navigateChatHistory(drafts, [], cursor, -1, 'x', 'node')).toBe(null)
    expect(navigateChatHistory(drafts, [], cursor, 1, 'x', 'node')).toBe(null)
  })

  it('single-entry history round-trips back to the draft', () => {
    const drafts = new Map()
    const cursor = makeCursor()
    expect(navigateChatHistory(drafts, ['only'], cursor, -1, 'draft', 'node')).toBe('only')
    expect(navigateChatHistory(drafts, ['only'], cursor, 1, 'only', 'node')).toBe('draft')
  })
})

describe('caret line detection for history navigation', () => {
  const element = (value, selectionStart, selectionEnd) => ({ value, selectionStart, selectionEnd })

  it('first line: any caret position on the first line triggers ArrowUp history', () => {
    expect(isCaretOnFirstLine(element('single line', 0, 0))).toBe(true)
    expect(isCaretOnFirstLine(element('single line', 5, 5))).toBe(true)
    expect(isCaretOnFirstLine(element('multi\nline', 3, 3))).toBe(true)
  })

  it('first line: caret after a newline is not on the first line', () => {
    expect(isCaretOnFirstLine(element('multi\nline', 6, 6))).toBe(false)
    expect(isCaretOnFirstLine(element('multi\nline', 11, 11))).toBe(false)
  })

  it('last line: caret on the last line triggers ArrowDown history', () => {
    expect(isCaretOnLastLine(element('multi\nline', 11, 11))).toBe(true)
    expect(isCaretOnLastLine(element('multi\nline', 6, 6))).toBe(true)
    expect(isCaretOnLastLine(element('single line', 5, 5))).toBe(true)
  })

  it('last line: caret before a newline is not on the last line', () => {
    expect(isCaretOnLastLine(element('multi\nline', 3, 3))).toBe(false)
    expect(isCaretOnLastLine(element('multi\nline', 0, 0))).toBe(false)
  })

  it('tolerates missing element fields', () => {
    expect(isCaretOnFirstLine(null)).toBe(true)
    expect(isCaretOnLastLine({ value: '' })).toBe(true)
  })
})
