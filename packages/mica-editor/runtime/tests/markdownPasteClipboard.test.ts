// @vitest-environment happy-dom
import {describe, expect, it} from 'vitest'
import {getMarkdownClipboardText} from '../src/playground/plugins/MarkdownPastePlugin/markdownPaste'

function clipboard(payload: Record<string, string>, extraTypes: string[] = []) {
  const data: Record<string, string> = payload
  return {
    types: [...Object.keys(payload), ...extraTypes],
    files: [],
    getData: (type: string) => data[type] ?? '',
  } as unknown as DataTransfer
}

// Copied from a real chat client: the same heading starts the plain text and the
// HTML payload, only wrapped in a single pre-wrap span.
const SOURCE = '# 自营企微群接入技术方案（简版）\n\n> 目标：让租车订单的用户、管家在企业微信客户群里沟通。\n\n核心原则：**系统准备和提醒，管家做最后确认。**'
const CHAT_HTML = `<meta charset='utf-8'><span style="white-space: pre-wrap;">${SOURCE}</span>`

describe('Markdown clipboard', () => {
  it('reads a chat-style wrapper as Markdown source', () => {
    expect(getMarkdownClipboardText(clipboard({'text/plain': SOURCE, 'text/html': CHAT_HTML}))).toBe(SOURCE)
  })

  it('reads layered neutral wrappers', () => {
    const html = `<div style="text-align: start;" dir="ltr"><p><span>${SOURCE}</span></p></div>`
    expect(getMarkdownClipboardText(clipboard({'text/plain': SOURCE, 'text/html': html}))).toBe(SOURCE)
  })

  it('keeps real formatting instead of reinterpreting it', () => {
    const rich = [
      '<h1>标题</h1>',
      '<p>正文<b>加粗</b></p>',
      '<ul><li># 列表项</li></ul>',
      '<p><a href="https://example.com">链接</a></p>',
      '<p><img src="https://example.com/a.png"></p>',
      '<table><tr><td>| a | b |</td></tr></table>',
    ]
    for (const html of rich) {
      expect(getMarkdownClipboardText(clipboard({'text/plain': SOURCE, 'text/html': html}))).toBe(null)
    }
  })

  it('keeps emphasis expressed as a style', () => {
    const html = `<span style="font-weight: 600; white-space: pre-wrap">${SOURCE}</span>`
    expect(getMarkdownClipboardText(clipboard({'text/plain': SOURCE, 'text/html': html}))).toBe(null)
  })

  it('keeps a rich rtf copy even when the plain text looks like Markdown', () => {
    expect(getMarkdownClipboardText(clipboard({'text/plain': SOURCE, 'text/html': CHAT_HTML}, ['text/rtf']))).toBe(null)
  })

  it('leaves ordinary prose alone', () => {
    const plain = '今天下午三点开会。'
    expect(getMarkdownClipboardText(clipboard({'text/plain': plain, 'text/html': `<span>${plain}</span>`}))).toBe(null)
  })

  it('still reads a bare code payload', () => {
    const html = '<pre data-language="markdown"><code># 标题</code></pre>'
    expect(getMarkdownClipboardText(clipboard({'text/plain': '# 标题', 'text/html': html}))).toBe('# 标题')
  })
})
