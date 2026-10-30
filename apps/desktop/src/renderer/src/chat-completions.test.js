import { describe, expect, it } from 'bun:test'
import {
  SKILL_COMPLETION_LIMIT,
  activeCompletion,
  applyCompletion,
  completionInsertText,
  fileCompletionOptions,
  mcpCompletionInsertText,
  matchIndexes,
  rankCompletions,
  skillCompletionOptions,
  slashCompletionOptions
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
    expect(
      completionInsertText({
        kind: 'skill',
        name: 'ask',
        path: '/home/u/.mica/skills/ask/SKILL.md'
      })
    ).toBe('/home/u/.mica/skills/ask/SKILL.md ')
    expect(completionInsertText({ kind: 'file', path: 'src/a.ts' })).toBe('@src/a.ts ')
    expect(completionInsertText({ kind: 'file', path: 'a b/c.ts' })).toBe('@"a b/c.ts" ')
  })

  it('quotes the skill path when it contains spaces and falls back to the name', () => {
    expect(
      completionInsertText({ kind: 'skill', name: 'ask', path: '/home/a b/skills/ask/SKILL.md' })
    ).toBe('"/home/a b/skills/ask/SKILL.md" ')
    // 老候选（没有 path）退回 `/name`，不至于插出一段空白
    expect(completionInsertText({ kind: 'skill', name: 'ask' })).toBe('/ask ')
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
      [
        {
          name: 'am-alarm-scan',
          description: '上线后的 AM 告警扫描',
          path: '/Users/me/.mica/skills/am-alarm-scan/SKILL.md'
        }
      ],
      'alarm'
    )

    expect(option).toMatchObject({
      key: 'skill:am-alarm-scan',
      kind: 'skill',
      name: 'am-alarm-scan',
      path: '/Users/me/.mica/skills/am-alarm-scan/SKILL.md',
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

  it('ranks skills and MCP servers in one list', () => {
    const options = slashCompletionOptions(
      {
        skills: [{ name: 'cooper', description: 'Cooper docs', path: '/h/skills/cooper/SKILL.md' }],
        mcpServers: [
          { name: 'mica-browser', type: 'http', tools: ['control'] },
          { name: 'mica-terminal', type: 'http', tools: ['control'] }
        ]
      },
      ''
    )

    expect(options.map((option) => option.label)).toEqual([
      '/cooper',
      'mcp:mica-browser',
      'mcp:mica-terminal'
    ])
  })

  it('narrows the merged list to the query and marks MCP labels after the prefix', () => {
    const options = slashCompletionOptions(
      {
        skills: [{ name: 'cooper', description: 'Cooper docs' }],
        mcpServers: [{ name: 'mica-browser', type: 'http', tools: ['control'] }]
      },
      'browser'
    )

    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({
      kind: 'mcp',
      name: 'mica-browser',
      label: 'mcp:mica-browser',
      tools: ['control'],
      description: '工具：control'
    })
    // 名称里从第 5 个字符（`mica-` 之后）开始命中，再右移 `mcp:` 的 4 个字符
    expect(options[0].highlights).toEqual([9, 10, 11, 12, 13, 14, 15])
  })

  it('still lists skills when the MCP side is empty or failed', () => {
    const options = slashCompletionOptions(
      { skills: [{ name: 'cooper', description: '' }], mcpServers: [] },
      ''
    )
    expect(options.map((option) => option.label)).toEqual(['/cooper'])
    expect(slashCompletionOptions({}, '')).toEqual([])
  })

  it('inserts the MCP server with its tool names', () => {
    expect(mcpCompletionInsertText({ name: 'mica-browser', tools: ['control'] })).toBe(
      '使用 MCP server「mica-browser」（工具：control） '
    )
    expect(completionInsertText({ kind: 'mcp', name: 'mica-browser', tools: ['control'] })).toBe(
      '使用 MCP server「mica-browser」（工具：control） '
    )
    // 工具名未知时只留 server 名，不编一段空括号
    expect(completionInsertText({ kind: 'mcp', name: 'sequential-thinking', tools: [] })).toBe(
      '使用 MCP server「sequential-thinking」 '
    )
  })

  it('carries a source marker so every row says where it came from', () => {
    const options = slashCompletionOptions(
      {
        skills: [
          {
            name: 'computer-use',
            description: '操作 macOS 桌面',
            path: '/h/computer-use/SKILL.md',
            source: { kind: 'plugin', label: '插件 computer-use', detail: 'computer-use' }
          },
          {
            name: 'demand-verify',
            description: '联调验收',
            path: '/p/.mica/skills/demand-verify/SKILL.md',
            source: { kind: 'project', label: '.mica/skills' }
          }
        ],
        mcpServers: [
          {
            name: 'mica-browser',
            type: 'http',
            tools: ['control'],
            source: { kind: 'builtin', label: '内置' }
          }
        ]
      },
      ''
    )

    // 名字排序：computer-use < demand-verify < mica-browser
    expect(options.map((option) => option.source)).toEqual([
      { kind: 'plugin', label: '插件 computer-use', detail: 'computer-use' },
      { kind: 'project', label: '.mica/skills' },
      { kind: 'builtin', label: '内置' }
    ])
    // 说明列只讲「这个 skill 干什么」，来源不挤进去
    expect(options[0].description).toBe('操作 macOS 桌面')
    expect(options[2].description).toBe('工具：control')
    // 内置 skill 插入的仍是 SKILL.md 的绝对路径
    expect(options[0].path).toBe('/h/computer-use/SKILL.md')
  })

  it('still matches on the source label, without pretending it is part of the description', () => {
    // 用户会按「插件」两个字找插件带来的那些；命中落在来源上，说明列不高亮
    const [match] = slashCompletionOptions(
      {
        skills: [
          {
            name: 'computer-use',
            description: '操作桌面',
            source: { kind: 'plugin', label: '插件 computer-use' }
          }
        ]
      },
      '插件'
    )
    expect(match.name).toBe('computer-use')
    expect(match.descriptionHighlights).toEqual([])
    expect(match.sourceLabel).toBe('插件 computer-use')
  })

  it('ignores a source the host spelled wrong instead of drawing a broken badge', () => {
    const [option] = slashCompletionOptions(
      { skills: [{ name: 'x', description: '', source: { kind: 'telepathy', label: '心灵感应' } }] },
      ''
    )
    expect(option.source).toBeUndefined()
    expect(slashCompletionOptions({ skills: [{ name: 'y', source: {} }] }, '')[0].source).toBeUndefined()
  })

  it('caps the listed tools so one pick cannot flood the composer', () => {
    const tools = Array.from({ length: 9 }, (_, index) => `tool-${index}`)
    expect(mcpCompletionInsertText({ name: 'big', tools })).toBe(
      '使用 MCP server「big」（工具：tool-0、tool-1、tool-2、tool-3、tool-4、tool-5 等） '
    )
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
