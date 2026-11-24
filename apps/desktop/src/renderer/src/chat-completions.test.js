import { describe, expect, it } from 'bun:test'
import {
  SKILL_COMPLETION_LIMIT,
  activeCompletion,
  applyCompletion,
  completionInsertText,
  fileCompletionOptions,
  filterSlashCompletionOptions,
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
    ).toBe('[skill:ask](/home/u/.mica/skills/ask/SKILL.md) ')
    expect(completionInsertText({ kind: 'file', path: 'src/a.ts' })).toBe('@src/a.ts ')
    expect(completionInsertText({ kind: 'file', path: 'a b/c.ts' })).toBe('@"a b/c.ts" ')
  })

  it('angle-wraps a path with spaces so the target stays readable', () => {
    expect(
      completionInsertText({ kind: 'skill', name: 'ask', path: '/home/a b/skills/ask/SKILL.md' })
    ).toBe('[skill:ask](</home/a b/skills/ask/SKILL.md>) ')
    // 括号在目标里同样会截断链接，一并包进去
    expect(completionInsertText({ kind: 'skill', name: 'ask', path: '/home/a(1)/SKILL.md' })).toBe(
      '[skill:ask](</home/a(1)/SKILL.md>) '
    )
    // 没有可打开的位置时只留名字，不编一枚点了没反应的链接
    expect(completionInsertText({ kind: 'skill', name: 'ask' })).toBe('[skill:ask] ')
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

  it('filters slash types before truncation and combines filtering with search', () => {
    const candidates = {
      skills: Array.from({ length: 205 }, (_, index) => ({ name: `skill-${index}` })),
      mcpServers: [{ name: 'browser' }],
      completions: [{ name: 'quick', description: 'browser helper', insert: 'use tool' }]
    }
    const all = slashCompletionOptions(candidates, '', Infinity)
    expect(filterSlashCompletionOptions(all, null)).toHaveLength(200)
    expect(filterSlashCompletionOptions(all, 'mcp').map((item) => item.name)).toEqual(['browser'])
    expect(filterSlashCompletionOptions(all, 'prompt').map((item) => item.name)).toEqual(['quick'])
    const searched = slashCompletionOptions(candidates, 'browser', Infinity)
    expect(filterSlashCompletionOptions(searched, 'prompt').map((item) => item.name)).toEqual(['quick'])
    expect(filterSlashCompletionOptions(searched, 'skill')).toEqual([])
    expect(filterSlashCompletionOptions(searched, null).map((item) => item.kind)).toEqual(['mcp', 'prompt'])
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

  it('keeps the MCP endpoint on the option so the insert text can link to it', () => {
    const [option] = slashCompletionOptions(
      {
        mcpServers: [
          { name: 'mica-browser', type: 'http', url: 'http://127.0.0.1:8787/mcp/browser' }
        ]
      },
      ''
    )

    expect(option.path).toBe('http://127.0.0.1:8787/mcp/browser')
    expect(completionInsertText(option)).toBe(
      '[mcp:mica-browser](http://127.0.0.1:8787/mcp/browser) '
    )
  })

  it('falls back to the config file for a stdio server, which has no endpoint', () => {
    const [option] = slashCompletionOptions(
      {
        mcpServers: [
          {
            name: 'sequential-thinking',
            type: 'stdio',
            source: { kind: 'config', label: 'config.json', detail: '/home/u/.mica/config.json' }
          }
        ]
      },
      ''
    )

    expect(option.path).toBe('/home/u/.mica/config.json')
    expect(completionInsertText(option)).toBe(
      '[mcp:sequential-thinking](/home/u/.mica/config.json) '
    )
  })

  it('still lists skills when the MCP side is empty or failed', () => {
    const options = slashCompletionOptions(
      { skills: [{ name: 'cooper', description: '' }], mcpServers: [] },
      ''
    )
    expect(options.map((option) => option.label)).toEqual(['/cooper'])
    expect(slashCompletionOptions({}, '')).toEqual([])
  })

  it('links the MCP server to its endpoint, falling back to the name', () => {
    expect(
      completionInsertText({
        kind: 'mcp',
        name: 'mica-browser',
        url: 'http://127.0.0.1:8787/mcp/browser',
        tools: ['control']
      })
    ).toBe('[mcp:mica-browser](http://127.0.0.1:8787/mcp/browser) ')
    expect(
      completionInsertText({
        kind: 'mcp',
        name: 'mica-browser',
        url: 'http://127.0.0.1:8787/mcp/browser'
      })
    ).toBe('[mcp:mica-browser](http://127.0.0.1:8787/mcp/browser) ')
    // stdio 的 server 没有接口地址，也没有可打开的位置：只留名字
    expect(completionInsertText({ kind: 'mcp', name: 'sequential-thinking', tools: [] })).toBe(
      '[mcp:sequential-thinking] '
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
            source: { kind: 'plugin', label: 'computer-use', detail: 'computer-use' }
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
            source: { kind: 'builtin', label: 'browser' }
          }
        ]
      },
      ''
    )

    // 名字排序：computer-use < demand-verify < mica-browser
    expect(options.map((option) => option.source)).toEqual([
      { kind: 'plugin', label: 'computer-use', detail: 'computer-use' },
      { kind: 'project', label: '.mica/skills' },
      { kind: 'builtin', label: 'browser' }
    ])
    // 行上只留类型标记；归属（前缀 + 实体名）不再出行，只在悬停提示里
    expect(options.map((option) => option.sourceText)).toEqual([undefined, undefined, undefined])
    expect(options.map((option) => option.kind)).toEqual(['skill', 'skill', 'mcp'])
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
            source: { kind: 'plugin', label: 'computer-use' }
          }
        ]
      },
      '插件'
    )
    expect(match.name).toBe('computer-use')
    expect(match.descriptionHighlights).toEqual([])
    // 只在来源里命中的条目照旧找得到；来源本身仍留在选项上（悬停提示用它的 detail）
    expect(match.source).toEqual({ kind: 'plugin', label: 'computer-use' })
  })

  it('ignores a source the host spelled wrong instead of drawing a broken badge', () => {
    const [option] = slashCompletionOptions(
      {
        skills: [{ name: 'x', description: '', source: { kind: 'telepathy', label: '心灵感应' } }]
      },
      ''
    )
    expect(option.source).toBeUndefined()
    expect(
      slashCompletionOptions({ skills: [{ name: 'y', source: {} }] }, '')[0].source
    ).toBeUndefined()
  })

  it('keeps the insert text one short link however many tools the server has', () => {
    const tools = Array.from({ length: 9 }, (_, index) => `tool-${index}`)
    expect(completionInsertText({ kind: 'mcp', name: 'big', tools })).toBe('[mcp:big] ')
  })

  it('插件声明的条目插进去的是它自己的正文，不是链接', () => {
    const insert = '用 demand_role 把这条经验写回角色文件（先 action=list 看小节）：'
    const options = slashCompletionOptions(
      {
        completions: [
          {
            name: 'role',
            description: '记一条经验',
            insert,
            pluginId: 'user.demand-dev',
            source: { kind: 'plugin', label: 'demand-dev', detail: 'user.demand-dev' }
          }
        ]
      },
      'ro'
    )
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({
      kind: 'prompt',
      label: '/role',
      description: '记一条经验',
      insert
    })
    // 类型标记是「指令」，来源仍是插件
    expect(options[0].source).toEqual({
      kind: 'plugin',
      label: 'demand-dev',
      detail: 'user.demand-dev'
    })
    expect(completionInsertText(options[0])).toBe(insert)
  })

  it('插件条目与 skill、MCP 一起按同一套评分排序', () => {
    const options = slashCompletionOptions(
      {
        skills: [{ name: 'role-check', description: '' }],
        mcpServers: [{ name: 'ro', tools: ['x'] }],
        completions: [
          {
            name: 'role',
            description: '',
            insert: 'x',
            pluginId: 'user.demo',
            source: { kind: 'plugin', label: 'demo' }
          }
        ]
      },
      'ro'
    )
    // 完全匹配的 MCP 第一；同档（前缀匹配）按来源顺序：skill 在前、插件条目在后
    expect(options.map((option) => option.kind)).toEqual(['mcp', 'skill', 'prompt'])
  })

  // 按需文档是「用到再读」：插进去的只有链接本身。把文档正文提前塞进输入框等于又注入了一次，
  // 前面这些条目存在的意义就没了。
  it('按需 URI 文档插入链接本身，不插入正文', () => {
    const uriApis = [
      {
        name: 'notebook',
        description: '笔记本的机读接口文档',
        uri: '/plugin/notebook/api',
        pluginId: 'notebook',
        source: { kind: 'plugin', label: 'notebook' }
      },
      {
        name: 'notes-site',
        description: '线上笔记站的接口文档',
        uri: 'https://mica.qirong77.com/plugin/notebook/api',
        pluginId: 'notebook',
        source: { kind: 'plugin', label: 'notebook' }
      }
    ]
    const options = slashCompletionOptions({ uriApis }, 'note')
    expect(options.map((option) => option.kind)).toEqual(['uri-api', 'uri-api'])
    expect(options[0]).toMatchObject({
      label: 'api:notebook',
      uri: '/plugin/notebook/api',
      // 来源原样留着：悬停提示用它说明是哪家插件给的文档
      source: { kind: 'plugin', label: 'notebook' }
    })
    expect(completionInsertText(options[0])).toBe('/plugin/notebook/api ')
    // 完整的 http 地址原样插入，不拼当前端口
    expect(completionInsertText(options[1])).toBe('https://mica.qirong77.com/plugin/notebook/api ')
  })

  it('按插件名也能搜到它给的 API 文档', () => {
    const uriApis = [
      {
        name: 'session-api',
        description: '',
        uri: '/plugin/demand-dev/api',
        pluginId: 'user.demand-dev',
        source: { kind: 'plugin', label: 'demand-dev', detail: 'user.demand-dev' }
      }
    ]
    expect(slashCompletionOptions({ uriApis }, 'dema').map((option) => option.name)).toEqual([
      'session-api'
    ])
  })

  // 用户记不住那 7 个入口叫什么，只会敲插件名（`/dema`）——来源标记必须参与匹配，
  // 否则这个入口只能靠逐字背下 `/claim`、`/desc` 才用得上。
  it('按插件名也能搜到它声明的条目', () => {
    const entries = ['claim', 'desc', 'role'].map((name) => ({
      name,
      description: '',
      insert: name,
      pluginId: 'user.demand-dev',
      source: { kind: 'plugin', label: 'demand-dev', detail: 'user.demand-dev' }
    }))
    const options = slashCompletionOptions({ completions: entries }, 'dema')
    expect(options.map((option) => option.name)).toEqual(['claim', 'desc', 'role'])
    // 只在来源里命中，来源原样留在选项上（悬停提示用它的 detail）
    expect(options[0].source).toEqual({
      kind: 'plugin',
      label: 'demand-dev',
      detail: 'user.demand-dev'
    })
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
