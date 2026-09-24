import { describe, expect, it } from 'bun:test'
import {
  activeCompletion,
  applyCompletion,
  completionInsertText,
  fileCompletionOptions,
  rankCompletions
} from './chat-completions'

describe('composer completions', () => {
  it('triggers the skill completion on a bare slash line', () => {
    expect(activeCompletion('/', 1)).toEqual({ kind: 'skill', start: 0, query: '' })
    expect(activeCompletion('/co', 3)).toEqual({ kind: 'skill', start: 0, query: 'co' })
  })

  it('triggers the skill completion wherever the slash starts a word', () => {
    expect(activeCompletion('看下 /co', 6)).toEqual({ kind: 'skill', start: 3, query: 'co' })
    expect(activeCompletion('/compact --local', 16)).toBeNull()
  })

  it('treats a second slash inside the token as a path, not a skill', () => {
    expect(activeCompletion('看下 /Users/qi', 12)).toBeNull()
    expect(activeCompletion('src/a/b.ts', 10)).toBeNull()
    expect(activeCompletion('and/or', 6)).toBeNull()
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

  it('keeps the file insert text identical to the CLI mention', () => {
    expect(completionInsertText({ kind: 'file', path: 'docs/' })).toBe('@docs/ ')
  })

  it('maps host mention candidates to palette options without re-ranking them', () => {
    const options = fileCompletionOptions([
      { path: 'docs/', label: 'docs/', description: 'docs', labelHighlights: [0, 1, 2, 3] },
      { path: 'src/a.ts', label: 'a.ts', description: 'src/a.ts', labelHighlights: [0] }
    ])

    expect(options.map((option) => option.key)).toEqual(['file:docs/', 'file:src/a.ts'])
    expect(options[0]).toMatchObject({
      kind: 'file',
      name: 'docs/',
      path: 'docs/',
      label: 'docs/',
      description: 'docs',
      highlights: [0, 1, 2, 3]
    })
    expect(fileCompletionOptions(null)).toEqual([])
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
