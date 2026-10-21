import { describe, expect, it } from 'bun:test'
import {
  SKILL_COMPLETION_LIMIT,
  activeCompletion,
  applyCompletion,
  completionInsertText,
  fileCompletionOptions,
  matchIndexes,
  rankCompletions,
  skillCompletionOptions
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

  it('matches the description too and ranks it after name matches', () => {
    const items = [
      { name: 'am-doctor', description: 'AgentMatrix 诊断请求' },
      { name: 'am-alarm-scan', description: 'AgentMatrix 上线后的告警扫描' },
      { name: 'am', description: '标准研发流程入口' }
    ]

    expect(rankCompletions(items, '告警').map((item) => item.name)).toEqual(['am-alarm-scan'])
    expect(rankCompletions(items, 'am').map((item) => item.name)).toEqual([
      'am',
      'am-doctor',
      'am-alarm-scan'
    ])
    expect(rankCompletions(items, 'agentmatrix').map((item) => item.name)).toEqual([
      'am-doctor',
      'am-alarm-scan'
    ])
  })

  it('keeps every skill instead of cutting the list down to a handful', () => {
    const skills = Array.from({ length: 120 }, (_, index) => ({ name: `skill-${index}` }))

    expect(SKILL_COMPLETION_LIMIT).toBeGreaterThanOrEqual(skills.length)
    expect(rankCompletions(skills, '').length).toBe(skills.length)
    expect(rankCompletions(skills, 'skill-1').length).toBe(
      skills.filter((skill) => skill.name.includes('skill-1')).length
    )
  })

  it('builds palette options with the slash prefix and highlighted matches', () => {
    const [option] = skillCompletionOptions(
      [{ name: 'am-alarm-scan', description: '上线后的 AM 告警扫描' }],
      'alarm'
    )

    expect(option).toMatchObject({
      key: 'skill:am-alarm-scan',
      kind: 'skill',
      name: 'am-alarm-scan',
      label: '/am-alarm-scan',
      description: '上线后的 AM 告警扫描'
    })
    // 名称里的下标整体右移一位（label 前面多了 `/`）
    expect(option.highlights).toEqual([4, 5, 6, 7, 8])
    expect(option.descriptionHighlights).toEqual([])
  })

  it('highlights the description when only it matches', () => {
    const [option] = skillCompletionOptions(
      [{ name: 'am-doctor', description: '诊断采集上报模块' }],
      '诊断'
    )

    expect(option.highlights).toEqual([])
    expect(option.descriptionHighlights).toEqual([0, 1])
  })

  it('accepts a missing skill list', () => {
    expect(skillCompletionOptions(null, 'x')).toEqual([])
  })

  it('matchIndexes finds every occurrence, ignoring case', () => {
    expect(matchIndexes('Aa-aa-AA', 'aa')).toEqual([0, 1, 3, 4, 6, 7])
    expect(matchIndexes('abc', '')).toEqual([])
  })

  it('replaces the trigger token with the completion text', () => {
    expect(applyCompletion('看下 @src/ch 的代码', 11, 3, '@src/chat.ts ')).toEqual({
      text: '看下 @src/chat.ts 的代码',
      caret: 16
    })
    expect(applyCompletion('/co', 3, 0, '/compact ')).toEqual({ text: '/compact ', caret: 9 })
  })
})
