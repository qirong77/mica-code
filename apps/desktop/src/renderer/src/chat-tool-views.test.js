import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThinkingRow, ToolActivityRow } from './chat-tool-views'
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
})

describe('ThinkingRow', () => {
  test('renders thinking as a labelled row, not a bare tinted block', () => {
    const html = renderToStaticMarkup(
      createElement(ThinkingRow, { text: '先看看 diff', startedAt: 1000, updatedAt: 2200 })
    )
    expect(html).toContain('chat-turn-log-thinking-label')
    expect(html).toContain('思考')
    expect(html).toContain('1.2s')
    expect(html).toContain('chat-turn-log-thinking-body')
  })

  test('says 思考中 while the model is still thinking', () => {
    const html = renderToStaticMarkup(
      createElement(ThinkingRow, { text: '还在想', done: false, startedAt: Date.now() })
    )
    expect(html).toContain('思考中')
  })

  test('empty thinking renders nothing', () => {
    expect(renderToStaticMarkup(createElement(ThinkingRow, { text: '   ' }))).toBe('')
  })
})
