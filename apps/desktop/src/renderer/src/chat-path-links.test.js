import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatPathContext } from './PathToken'
import { Markdown, MessageText } from './ChatView'

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

const renderMessage = (text, value = actions) =>
  renderToStaticMarkup(
    createElement(ChatPathContext.Provider, { value }, createElement(MessageText, { text }))
  )

describe('chat markdown path links', () => {
  it('turns a bare path in prose into a clickable element', () => {
    const html = render('先看 /Users/qironglin/Desktop/qirong-application 再决定')
    expect(html).toContain('chat-path')
    expect(html).toContain('/Users/qironglin/Desktop/qirong-application')
    expect(html).toContain('role="link"')
    expect(html).toContain(
      'title="单击选择打开方式：/abs/Users/qironglin/Desktop/qirong-application'
    )
    expect(html).toContain('直接在 Mica 中打开')
  })

  it('marks image paths so a click opens the preview', () => {
    const html = render('截图在 /tmp/shot.png')
    expect(html).toContain('chat-path-image')
    expect(html).toContain('单击预览图片')
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

// 对话区不内联渲染图片：`[Image](路径)` 与 markdown 图片都只留链接文本（见 ImageLink）。
describe('chat image references render as links', () => {
  it('drops the [Image](...) wrapper from a user message and keeps the path clickable', () => {
    const html = renderMessage('看这个 [Image](~/.mica/images/a.png) 对不对')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('[Image](')
    expect(html).toContain('chat-path-image')
    expect(html).toContain('~/.mica/images/a.png')
  })

  it('keeps a meaningful alt as the link text', () => {
    const html = renderMessage('![谱](/tmp/a.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('谱')
  })

  it('never renders a markdown image inline', () => {
    const html = render('![截图](/tmp/a.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('截图')
  })

  it('falls back to the path when the alt carries no information', () => {
    const html = render('![](/tmp/a.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('/tmp/a.png')
  })

  it('turns a remote image into an external link', () => {
    const html = render('![shot](https://example.com/a.png)')
    expect(html).not.toContain('<img')
    expect(html).toContain('href="https://example.com/a.png"')
    expect(html).toContain('shot')
  })

  it('never dumps a data url into the message body', () => {
    const html = render('![](data:image/png;base64,AAAA)')
    expect(html).not.toContain('<img')
    expect(html).toContain('chat-image-ref')
    expect(html).not.toContain('base64')
  })
})
