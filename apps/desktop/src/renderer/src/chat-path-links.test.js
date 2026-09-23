import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatPathContext } from './PathToken'
import { Markdown } from './ChatView'

const actions = {
  resolvePath: (raw) => `/abs${raw.startsWith('/') ? '' : '/'}${raw}`,
  openFile: () => {},
  reveal: () => {},
  preview: () => {}
}

const render = (text, value = actions) =>
  renderToStaticMarkup(
    createElement(ChatPathContext.Provider, { value }, createElement(Markdown, { text }))
  )

describe('chat markdown path links', () => {
  it('turns a bare path in prose into a clickable element', () => {
    const html = render('先看 /Users/qironglin/Desktop/qirong-application 再决定')
    expect(html).toContain('chat-path')
    expect(html).toContain('/Users/qironglin/Desktop/qirong-application')
    expect(html).toContain('role="link"')
    expect(html).toContain(
      'title="点击在 Finder 中打开：/abs/Users/qironglin/Desktop/qirong-application'
    )
  })

  it('marks image paths so a click opens the preview', () => {
    const html = render('截图在 /tmp/shot.png')
    expect(html).toContain('chat-path-image')
    expect(html).toContain('点击预览图片')
  })

  it('falls back to plain text without a path action context', () => {
    const html = render('见 /tmp/a.ts', null)
    expect(html).not.toContain('chat-path')
    expect(html).toContain('/tmp/a.ts')
  })

  it('leaves code spans and existing links alone', () => {
    const html = render('`/tmp/a.ts` 与 [链接](https://example.com/tmp/a.ts)')
    expect(html).not.toContain('chat-path')
    expect(html).toContain('href="https://example.com/tmp/a.ts"')
  })

  it('keeps the :line:column suffix on the rendered text', () => {
    const html = render('at src/app.ts:12:5')
    expect(html).toContain('src/app.ts:12:5')
  })
})
