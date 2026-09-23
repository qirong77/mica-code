import { describe, expect, it } from 'bun:test'
import {
  activeCompletion,
  applyCompletion,
  completionInsertText,
  rankCompletions
} from './chat-completions'

describe('composer completions', () => {
  it('triggers the skill completion on a bare slash line', () => {
    expect(activeCompletion('/', 1)).toEqual({ kind: 'skill', start: 0, query: '' })
    expect(activeCompletion('/co', 3)).toEqual({ kind: 'skill', start: 0, query: 'co' })
  })

  it('stops the slash completion once the line has arguments or plain text', () => {
    expect(activeCompletion('/compact --local', 16)).toBeNull()
    expect(activeCompletion('explain /co', 11)).toBeNull()
  })

  it('triggers the file completion on the token after the at sign', () => {
    expect(activeCompletion('看下 @src/ch', 11)).toEqual({
      kind: 'file',
      start: 3,
      query: 'src/ch'
    })
    expect(activeCompletion('@', 1)).toEqual({ kind: 'file', start: 0, query: '' })
    expect(activeCompletion('mail@example.com', 16)).toBeNull()
  })

  it('builds insert texts for both kinds', () => {
    expect(completionInsertText({ kind: 'skill', name: 'ask' })).toBe('/ask ')
    expect(completionInsertText({ kind: 'file', path: 'src/a.ts' })).toBe('@src/a.ts ')
    expect(completionInsertText({ kind: 'file', path: 'a b/c.ts' })).toBe('@"a b/c.ts" ')
  })

  it('ranks exact, prefix and substring matches ahead of the rest', () => {
    const items = [
      { name: 'zeta' },
      { name: 'compact-notes' },
      { name: 'compact' },
      { name: 'local-compact' }
    ]
    expect(rankCompletions(items, 'compact').map((item) => item.name)).toEqual([
      'compact',
      'compact-notes',
      'local-compact'
    ])
    expect(rankCompletions(items, '').map((item) => item.name)).toEqual([
      'zeta',
      'compact-notes',
      'compact',
      'local-compact'
    ])
  })

  it('replaces the trigger token with the completion text', () => {
    expect(applyCompletion('看下 @src/ch 的代码', 11, 3, '@src/chat.ts ')).toEqual({
      text: '看下 @src/chat.ts 的代码',
      caret: 16
    })
    expect(applyCompletion('/co', 3, 0, '/compact ')).toEqual({ text: '/compact ', caret: 9 })
  })
})
