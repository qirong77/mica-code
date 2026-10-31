import { describe, expect, it } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatPathContext } from './PathToken'
import { Markdown, MessageText, UserMessageText } from './ChatView'
import { ReasoningRow } from './chat-tool-views'
import { buildQuoteBlock } from './quote-message'

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

const renderUser = (text, value = actions) =>
  renderToStaticMarkup(
    createElement(ChatPathContext.Provider, { value }, createElement(UserMessageText, { text }))
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

  it('leaves existing links alone', () => {
    const html = render('[链接](https://example.com/tmp/a.ts)')
    expect(html).not.toContain('chat-path')
    expect(html).toContain('href="https://example.com/tmp/a.ts"')
  })

  it('keeps the path clickable inside an inline code span', () => {
    const html = render('改 `src/app.ts:12` 这一行')
    expect(html).toContain('<code>')
    expect(html).toContain('chat-path')
    expect(html).toContain('src/app.ts:12')
  })

  it('keeps a fenced code block literal', () => {
    const html = render('```\nhttps://example.com/a\n```')
    expect(html).not.toContain('<a href="https://example.com/a"')
    expect(html).toContain('chat-code-block')
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

// 纯文本区域（用户消息、引用块、思考）不走 markdown，链接要自己认出来：
// 助手消息里的链接由 GFM autolink 负责，这里补的是另一半。
describe('chat plain text links', () => {
  it('turns a bare URL in a user message into a clickable link', () => {
    const html = renderUser('使用 http://127.0.0.1:8787/remote/control 看看')
    expect(html).toContain('class="chat-link"')
    expect(html).toContain('href="http://127.0.0.1:8787/remote/control"')
    // URL 里的 `//host/path` 不该被路径识别抢走
    expect(html).not.toContain('chat-path')
  })

  it('stops the link at full-width punctuation glued to it', () => {
    const html = renderUser('访问https://example.com/a，整理面试题')
    expect(html).toContain('href="https://example.com/a"')
    expect(html).not.toContain('href="https://example.com/a，整理面试题"')
    expect(html).toContain('整理面试题')
  })

  it('keeps the www form clickable and keeps the written text', () => {
    const html = renderUser('看 www.example.com 吧')
    expect(html).toContain('href="http://www.example.com"')
    expect(html).toContain('>www.example.com<')
  })

  it('renders links and paths side by side in one message', () => {
    const html = renderUser('打开 /Users/qironglin/Desktop/mica-code 再看 https://example.com/a')
    expect(html).toContain('href="https://example.com/a"')
    expect(html).toContain('/abs/Users/qironglin/Desktop/mica-code')
    expect(html).toContain('role="link"')
  })

  it('makes paths clickable inside a quote block', () => {
    const text = `${buildQuoteBlock({ role: 'assistant', text: '看 /Users/qironglin/Desktop/mica-code' })}\n\n继续`
    const html = renderUser(text)
    expect(html).toContain('chat-quote-text')
    expect(html).toContain('/abs/Users/qironglin/Desktop/mica-code')
  })

  it('makes links and paths clickable in the reasoning body', () => {
    const html = renderToStaticMarkup(
      createElement(
        ChatPathContext.Provider,
        { value: actions },
        createElement(ReasoningRow, { text: '看 https://example.com/a 与 /tmp/a.ts' })
      )
    )
    expect(html).toContain('href="https://example.com/a"')
    expect(html).toContain('/abs/tmp/a.ts')
  })
})

// 模型几乎总是用反引号写 URL 和路径（`http://x`、`src/app.ts`），所以行内代码里的
// 这两种写法也必须可点：外壳仍是 <code>，样式不变，内容换成可点元素。
describe('chat links inside inline code', () => {
  it('makes a URL in an inline code span clickable', () => {
    const html = render('地址 `http://155.254.127.215/interview/` 已上线')
    expect(html).toContain('<code><a href="http://155.254.127.215/interview/"')
    expect(html).not.toContain('cursor: auto')
  })

  it('keeps the surrounding code span unchanged when there is nothing to link', () => {
    expect(render('跑 `npm run dev` 启动')).toContain('<code>npm run dev</code>')
  })

  it('links a path and keeps the :line suffix readable', () => {
    const html = render('见 `apps/desktop/src/renderer/src/ChatView.jsx:261`')
    expect(html).toContain('chat-path')
    expect(html).toContain('ChatView.jsx:261')
  })
})
