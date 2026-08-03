import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  Markdown,
  activeSubagentMessages,
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
  todoItemsForTurn
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
    expect(html).toContain('const ready = true')
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
  it('uses the latest TodoWrite replacement list and ignores malformed rows', () => {
    const first = {
      kind: 'tool',
      tool: {
        tool: 'TodoWrite',
        status: 'completed',
        input: {
          todos: [{ content: 'Inspect', activeForm: 'Inspecting', status: 'in_progress' }]
        }
      }
    }
    const latest = {
      kind: 'tool',
      tool: {
        tool: 'TodoWrite',
        status: 'completed',
        input: {
          todos: [
            { content: 'Inspect', activeForm: 'Inspecting', status: 'completed' },
            { content: 'Test', activeForm: 'Testing', status: 'in_progress' }
          ]
        }
      }
    }
    const rejected = {
      kind: 'tool',
      tool: {
        tool: 'TodoWrite',
        status: 'completed',
        input: {
          todos: [
            { content: 'One', activeForm: 'Doing one', status: 'in_progress' },
            { content: 'Two', activeForm: 'Doing two', status: 'in_progress' }
          ]
        }
      }
    }

    expect(latestTodoItems([first, latest, rejected])).toEqual([
      { content: 'Inspect', activeForm: 'Inspecting', status: 'completed' },
      { content: 'Test', activeForm: 'Testing', status: 'in_progress' }
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
        tool: { tool: 'Agent', status: 'running' }
      },
      {
        id: 'agent-done',
        kind: 'tool',
        turnId: 'turn-2',
        tool: { tool: 'Agent', status: 'completed' }
      }
    ]

    expect(currentTurnActivityMessages(messages, 'turn-2').map((message) => message.id)).toEqual([
      'thought',
      'read',
      'agent-running',
      'agent-done'
    ])
    expect(activeSubagentMessages(messages, 'turn-2').map((message) => message.id)).toEqual([
      'agent-running'
    ])
  })

  it('pauses an in-progress todo outside its owning active turn', () => {
    const messages = [
      {
        kind: 'tool',
        turnId: 'turn-1',
        tool: {
          tool: 'TodoWrite',
          status: 'completed',
          input: {
            todos: [{ content: 'Inspect', activeForm: 'Inspecting', status: 'in_progress' }]
          }
        }
      }
    ]

    expect(todoItemsForTurn(messages, 'turn-1', true)[0].status).toBe('in_progress')
    expect(todoItemsForTurn(messages, 'turn-1', false)[0].status).toBe('pending')
    expect(todoItemsForTurn(messages, 'turn-2', true)[0].status).toBe('pending')
  })
})
