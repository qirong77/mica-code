import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReasoningRow, ToolActivityRow } from './chat-tool-views'
import { subagentToolOf } from './chat-task-detail'

/**
 * 回合日志那两行（思考 / 工具调用）现在有三个消费者：主对话、BTW 抽屉、subagent
 * 详情。它们拿到的是三种不同形状的数据（app-server 工具事件、btw 活动、subagent
 * 时间线），所以这里盯住「subagent 的步骤转成工具行之后仍然是一条日志行」这件事。
 */
describe('ToolActivityRow', () => {
  test('renders a running subagent step as a turn-log tool line', () => {
    const tool = subagentToolOf(
      {
        key: 'c:0',
        kind: 'tool',
        toolName: 'read_file',
        argsText: '{"file_path":"/tmp/a.txt"}',
        resultText: '',
        startedAt: Date.now() - 2000
      },
      true
    )
    const html = renderToStaticMarkup(createElement(ToolActivityRow, { tool, now: Date.now() }))
    expect(html).toContain('chat-turn-log-tool')
    expect(html).toContain('chat-turn-log-running')
    expect(html).toContain('/tmp/a.txt')
  })

  test('keeps an orphan subagent result as a settled line without a bogus duration', () => {
    const tool = subagentToolOf({
      key: 'd:0',
      kind: 'tool_result',
      toolName: 'run_shell',
      text: 'done'
    })
    const html = renderToStaticMarkup(createElement(ToolActivityRow, { tool }))
    expect(html).toContain('chat-turn-log-complete')
    expect(html).not.toContain('0ms')
  })

  test('does not show the current elapsed time for an unmatched historical call', () => {
    const tool = subagentToolOf({
      key: 'c:0',
      kind: 'tool',
      toolName: 'read_file',
      argsText: '{}',
      resultText: '',
      startedAt: Date.now() - 120000
    })
    const html = renderToStaticMarkup(createElement(ToolActivityRow, { tool, now: Date.now() }))
    expect(html).toContain('chat-turn-log-unknown')
    expect(html).not.toContain('2m')
  })
})

describe('ReasoningRow', () => {
  test('renders thinking with the turn-log background block', () => {
    const html = renderToStaticMarkup(createElement(ReasoningRow, { text: '先看看 diff' }))
    expect(html).toBe('<div class="chat-turn-log-thinking">先看看 diff</div>')
  })

  test('drops blank lines between thinking paragraphs', () => {
    const html = renderToStaticMarkup(
      createElement(ReasoningRow, {
        text: '**Adding official source retrieval**\n\n\n**Building demo agent runner**\n\n\n   \n**Validating evidence sources**\n\n'
      })
    )
    expect(html).toBe(
      '<div class="chat-turn-log-thinking">**Adding official source retrieval**' +
        '\n**Building demo agent runner**\n**Validating evidence sources**</div>'
    )
  })

  test('renders nothing when thinking is only blank lines', () => {
    expect(renderToStaticMarkup(createElement(ReasoningRow, { text: '\n\n  \r\n\n' }))).toBe('')
  })

  test('keeps CRLF thinking on one blank-line-free block', () => {
    const html = renderToStaticMarkup(createElement(ReasoningRow, { text: 'a\r\n\r\nb' }))
    expect(html).toBe('<div class="chat-turn-log-thinking">a\nb</div>')
  })
})
