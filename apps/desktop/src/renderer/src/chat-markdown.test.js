import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  Markdown,
  canReuseVisualTranscript,
  chatUrlTransform,
  currentTurnActivityMessages,
  fileTarget,
  hasPersistedTurn,
  historyBeforeRunReplay,
  isPersistedRunComplete,
  latestTodoItems,
  mergeReplayEvents,
  resolveChatPath,
  todoSnapshotFromMessages,
  todoPanelForTurn
} from './ChatView'

describe('chat Markdown', () => {
  it('renders GFM tables, task lists, nested lists, and fenced code', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        text: [
          '| Name | State |',
          '| --- | --- |',
          '| mica | ready |',
          '',
          '- [x] parsed',
          '  - nested',
          '',
          '```ts',
          'const ready = true',
          '```'
        ].join('\n')
      })
    )

    expect(html).toContain('<table>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('nested')
    expect(html).toContain('chat-code-block')
    // 代码块按 token 拆成了 span，文本本身仍要一字不差
    expect(html).toContain('data-language="ts"')
    expect(html).toContain('code-tok-literal')
    expect(html.replace(/<[^>]+>/g, '')).toContain('const ready = true')
  })

  it('does not render raw HTML from model output', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { text: '<script>window.bad = true</script>\n\nSafe text' })
    )

    expect(html).not.toContain('<script>')
    expect(html).toContain('Safe text')
  })

  it('keeps Windows file links while rejecting executable URL schemes', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        text: '[file](C:/work/src/App.ts:12:3) [unsafe](javascript:alert(1))'
      })
    )

    expect(html).toContain('href="C:/work/src/App.ts:12:3"')
    expect(html).not.toContain('href="javascript:')
    expect(chatUrlTransform('javascript:alert(1)')).toBe('')
  })

  it('keeps full-width sentence punctuation outside autolinks', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { text: '已部署到 http://10.190.46.109:9200。' })
    )

    expect(html).toContain('href="http://10.190.46.109:9200"')
    expect(html).not.toContain('9200。')
    expect(html).toContain('</a>。')
  })

  it('leaves an explicit link alone when its text has no trailing punctuation', () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, { text: '[看这里](http://10.190.46.109:9200。)' })
    )

    // 显式链接的目标就是用户写的那一串，不能悄悄裁掉它的句号。
    expect(html).toContain('href="http://10.190.46.109:9200%E3%80%82"')
  })

  it('keeps bold around a bare URL when full-width punctuation follows it', () => {
    // autolink literal 会把收尾的 `**` 和其后的中文一起吃进链接，这对分隔符就再也配不上，
    // 页面上留下字面量 `**`（模型最常写的正是这种「加粗一个地址」）。
    const html = renderToStaticMarkup(
      createElement(Markdown, { text: '页面已启动：**http://127.0.0.1:8877**（打开即可）。' })
    )

    expect(html).toContain('<strong><a href="http://127.0.0.1:8877">')
    expect(html).toContain('</a></strong>（打开即可）。')
    expect(html).not.toContain('**')
  })

  it('keeps bold around www addresses and emphasis around URLs with inner text', () => {
    const www = renderToStaticMarkup(
      createElement(Markdown, { text: '看 **www.example.com**（示例）' })
    )
    expect(www).toContain('<strong><a href="http://www.example.com">www.example.com</a></strong>')

    const italic = renderToStaticMarkup(
      createElement(Markdown, { text: '结束 *https://x.com/a，然后* 继续' })
    )
    expect(italic).toContain('<em><a href="https://x.com/a">https://x.com/a</a>，然后</em>')
  })

  it('leaves emphasis-wrapped URLs inside code alone', () => {
    const inline = renderToStaticMarkup(
      createElement(Markdown, { text: '写法 `**http://x/a**` 是代码' })
    )
    expect(inline).toContain('<code>**<a href="http://x/a">http://x/a</a>**</code>')

    const fenced = renderToStaticMarkup(
      createElement(Markdown, { text: '```\n**http://x/a**（说明）\n```' })
    )
    expect(fenced).toContain('**http://x/a**（说明）')
  })
})

describe('fileTarget', () => {
  it('parses local file line and column links without treating web URLs as files', () => {
    expect(fileTarget('/work/src/App.jsx#L42C7')).toEqual({
      path: '/work/src/App.jsx',
      line: 42,
      column: 7
    })
    expect(fileTarget('src/App.jsx:12:3')).toEqual({ path: 'src/App.jsx', line: 12, column: 3 })
    expect(fileTarget('C:\\work\\src\\App.ts:12:3')).toEqual({
      path: 'C:\\work\\src\\App.ts',
      line: 12,
      column: 3
    })
    expect(fileTarget('file:///work/src/App.ts#L42C7')).toEqual({
      path: '/work/src/App.ts',
      line: 42,
      column: 7
    })
    expect(fileTarget('file://server/share/App.ts:12')).toEqual({
      path: '//server/share/App.ts',
      line: 12,
      column: 1
    })
    expect(fileTarget('https://example.com/file.ts:12')).toBeNull()
  })

  it('resolves relative targets against the conversation working directory', () => {
    expect(resolveChatPath('src/App.jsx', '/work/project')).toBe('/work/project/src/App.jsx')
    expect(resolveChatPath('src\\App.ts', 'C:\\work\\project')).toBe(
      'C:\\work\\project\\src\\App.ts'
    )
    expect(resolveChatPath('/tmp/App.jsx', '/work/project')).toBe('/tmp/App.jsx')
    expect(resolveChatPath('\\\\server\\share\\App.ts', 'C:\\work\\project')).toBe(
      '\\\\server\\share\\App.ts'
    )
  })
})

describe('mergeReplayEvents', () => {
  it('keeps buffered ordering and applies only newer live events', () => {
    const text = { type: 'text', part: { type: 'text', text: 'before' } }
    const tool = { type: 'tool_use', part: { type: 'tool', tool: 'read_file' } }
    const after = { type: 'text', part: { type: 'text', text: 'after' } }

    expect(
      mergeReplayEvents(
        [
          { sequence: 4, event: text },
          { sequence: 5, event: tool }
        ],
        [
          { sequence: 5, event: tool },
          { sequence: 6, event: after }
        ]
      )
    ).toEqual([text, tool, after])
  })

  it('detects when the active prompt and answer are already present in persisted history', () => {
    expect(
      hasPersistedTurn(
        [
          { role: 'user', text: 'same prompt' },
          { role: 'assistant', text: 'saved answer' }
        ],
        'same prompt'
      )
    ).toBe(true)
    expect(hasPersistedTurn([{ role: 'user', text: 'same prompt' }], 'same prompt')).toBe(false)
  })

  it('requires the persisted completion to be newer than the active run', () => {
    const startedAt = Date.parse('2026-08-02T08:00:00.000Z')
    expect(
      isPersistedRunComplete(
        { turnState: 'completed', updatedAt: '2026-08-02T07:59:59.999Z' },
        startedAt
      )
    ).toBe(false)
    expect(
      isPersistedRunComplete(
        { turnState: 'completed', updatedAt: '2026-08-02T08:00:00.001Z' },
        startedAt
      )
    ).toBe(true)
  })
})

describe('visual transcript cache', () => {
  it('retains completed thinking and tool rows only when persisted messages still match', () => {
    const cached = [
      { kind: 'message', role: 'user', text: 'inspect' },
      { kind: 'reasoning', role: 'assistant', text: 'thinking' },
      { kind: 'message', role: 'assistant', text: 'before ' },
      { kind: 'tool', role: 'tool', tool: { tool: 'read_file' } },
      { kind: 'message', role: 'assistant', text: 'after' }
    ]

    expect(
      canReuseVisualTranscript(cached, [
        { kind: 'message', role: 'user', text: 'inspect' },
        { kind: 'message', role: 'assistant', text: 'before after' }
      ])
    ).toBe(true)
    expect(
      canReuseVisualTranscript(cached, [
        { kind: 'message', role: 'user', text: 'newer prompt' },
        { kind: 'message', role: 'assistant', text: 'new answer' }
      ])
    ).toBe(false)
  })
})

describe('structured activity state', () => {
  it('uses the latest todo_write replacement list', () => {
    const first = {
      kind: 'tool',
      tool: {
        tool: 'todo_write',
        status: 'completed',
        input: {
          todos: [{ content: 'Inspect', activeForm: 'Inspecting', status: 'in_progress' }]
        }
      }
    }
    const latest = {
      kind: 'tool',
      tool: {
        tool: 'todo_write',
        status: 'completed',
        input: {
          todos: [
            { content: 'Inspect', activeForm: 'Inspecting', status: 'completed' },
            { content: 'Test', status: 'in_progress' }
          ]
        }
      }
    }

    expect(latestTodoItems([first, latest])).toEqual([
      { id: 'Inspect', content: 'Inspect', activeForm: 'Inspecting', status: 'completed' },
      { id: 'Test', content: 'Test', activeForm: undefined, status: 'in_progress' }
    ])
  })

  it('skips a streaming todo row and normalizes extra in-progress entries', () => {
    const streaming = {
      kind: 'tool',
      tool: {
        tool: 'todo_write',
        status: 'running',
        input: {
          todos: [{ content: 'Half', status: 'pending' }]
        }
      }
    }
    const twoActive = {
      kind: 'tool',
      tool: {
        tool: 'todo_write',
        status: 'completed',
        input: {
          todos: [
            { content: 'One', status: 'in_progress' },
            { content: 'Two', status: 'in_progress' }
          ]
        }
      }
    }

    expect(latestTodoItems([streaming, twoActive]).map((item) => item.status)).toEqual([
      'in_progress',
      'pending'
    ])
  })

  it('replays a completed background turn from its persisted user boundary', () => {
    const messages = [
      { role: 'user', text: 'older' },
      { role: 'assistant', text: 'older answer' },
      { role: 'user', text: 'active prompt' },
      { role: 'assistant', text: 'persisted final answer' }
    ]

    expect(historyBeforeRunReplay(messages, 'active prompt')).toEqual(messages.slice(0, 3))
  })

  it('keeps user messages persisted inside the active turn when trimming for replay', () => {
    const messages = [
      { role: 'user', text: 'active prompt' },
      { role: 'assistant', text: 'first answer' },
      { role: 'user', text: 'steered follow-up' },
      { role: 'assistant', text: 'second answer' }
    ]

    expect(historyBeforeRunReplay(messages, 'active prompt')).toEqual([messages[0], messages[2]])
  })

  it('matches the active prompt across the persisted image placeholder', () => {
    const messages = [
      { role: 'user', text: 'look at [Image](~/.mica/images/a.png)[图片]' },
      { role: 'assistant', text: 'checkpointed answer' }
    ]

    expect(historyBeforeRunReplay(messages, 'look at [Image](~/.mica/images/a.png)')).toEqual([
      messages[0]
    ])
    expect(hasPersistedTurn(messages, 'look at [Image](~/.mica/images/a.png)')).toBe(true)
  })

  it('keeps current-turn logs separate from active subagent status', () => {
    const messages = [
      { id: 'old', kind: 'reasoning', turnId: 'turn-1', text: 'old thought' },
      { id: 'thought', kind: 'reasoning', turnId: 'turn-2', text: 'current thought' },
      {
        id: 'read',
        kind: 'tool',
        turnId: 'turn-2',
        tool: { tool: 'read_file', status: 'completed' }
      },
      {
        id: 'agent-running',
        kind: 'tool',
        turnId: 'turn-2',
        tool: { tool: 'agent', status: 'running' }
      },
      {
        id: 'agent-done',
        kind: 'tool',
        turnId: 'turn-2',
        tool: { tool: 'agent', status: 'completed' }
      }
    ]

    expect(currentTurnActivityMessages(messages, 'turn-2').map((message) => message.id)).toEqual([
      'thought',
      'read',
      'agent-running',
      'agent-done'
    ])
  })

  it('keeps the turn log when the replay window lost the turn id', () => {
    // 回归点：窗口在轮次中途附着上来（切走再切回、重开窗口）时，host 的事件缓冲
    // 可能已经把 step_start 挤出去，重放出来的思考与工具行一个轮次键都拿不到。
    // 这条路径下状态行说在 thinking，日志区却整块消失。
    const messages = [
      { id: 'old', kind: 'reasoning', turnId: 'turn-1', text: 'old thought' },
      { id: 'live-thought', kind: 'reasoning', turnId: null, text: 'current thought' },
      {
        id: 'live-tool',
        kind: 'tool',
        turnId: null,
        tool: { tool: 'read_file', status: 'running' }
      }
    ]

    expect(currentTurnActivityMessages(messages, null).map((message) => message.id)).toEqual([
      'live-thought',
      'live-tool'
    ])
    // 有轮次键时仍然严格匹配：上一轮的思考不能跟着回到日志区。
    expect(currentTurnActivityMessages(messages, 'turn-1').map((message) => message.id)).toEqual([
      'old'
    ])
  })

  it('shows the plan only while its own turn runs', () => {
    const messages = [
      {
        kind: 'tool',
        turnId: 'turn-1',
        tool: {
          tool: 'todo_write',
          status: 'completed',
          input: {
            todos: [{ content: 'Inspect', status: 'in_progress' }]
          }
        }
      }
    ]

    expect(todoPanelForTurn(messages, 'turn-1', true)).toEqual({
      items: [{ id: 'Inspect', content: 'Inspect', activeForm: undefined, status: 'in_progress' }],
      visible: true
    })
    // 回归点：轮次结束后不能继续把上一轮的计划挂在页面上。
    expect(todoPanelForTurn(messages, 'turn-1', false)).toEqual({ items: [], visible: false })
    // 回归点：新的一轮开始时，历史里上一轮的清单不得重新出现。
    expect(todoPanelForTurn(messages, 'turn-2', true)).toEqual({ items: [], visible: false })
  })

  it('keeps leftover items unfinished in the data while the turn runs', () => {
    const messages = [
      {
        kind: 'tool',
        turnId: 'turn-1',
        tool: {
          tool: 'todo_write',
          status: 'completed',
          input: {
            todos: [
              { content: 'Inspect', activeForm: 'Inspecting', status: 'completed' },
              { content: 'Test', activeForm: 'Testing', status: 'in_progress' },
              { content: 'Ship', activeForm: 'Shipping', status: 'pending' }
            ]
          }
        }
      }
    ]

    // 回归点：turn 结束不伪造完成，数据仍然只有一项完成。
    expect(latestTodoItems(messages).map((item) => item.status)).toEqual([
      'completed',
      'in_progress',
      'pending'
    ])
    expect(todoSnapshotFromMessages([])).toEqual({ items: [], turnId: null })
  })

  it('drops the dock when the todo list belongs to an older turn', () => {
    const messages = [
      {
        kind: 'tool',
        turnId: 'turn-1',
        tool: {
          tool: 'todo_write',
          status: 'completed',
          input: { todos: [{ content: 'Old plan', status: 'pending' }] }
        }
      }
    ]

    // 空闲时没有活跃轮次：不能因为历史里还有一条 todo_write 就一直显示。
    expect(todoPanelForTurn(messages, null, false)).toEqual({ items: [], visible: false })
    expect(todoPanelForTurn(messages, 'turn-1', true, true)).toEqual({ items: [], visible: false })
  })
})
