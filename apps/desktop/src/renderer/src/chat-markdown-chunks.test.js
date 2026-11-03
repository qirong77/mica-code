import { describe, expect, it } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { splitMarkdownChunks } from './chat-markdown-chunks'

const chunksOf = (text) => splitMarkdownChunks(text)

describe('splitMarkdownChunks', () => {
  it('切块后拼回去仍是同一份文本', () => {
    const text =
      '# 标题\n\n第一段\n\n- a\n\n- b\n\n```js\nconst x = 1\n\nconst y = 2\n```\n\n结尾\n'
    const chunks = chunksOf(text)
    expect(chunks.join('')).toBe(text)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('不在围栏代码块内部切开', () => {
    const text = '前文\n\n```\n第一段\n\n第二段\n\n```\n\n后文'
    const chunks = chunksOf(text)
    expect(chunks.length).toBe(3)
    // 两个围栏必须在同一块里，否则空行会把代码块劈成两段
    const blocks = chunks.filter((chunk) => chunk.includes('```'))
    expect(blocks.length).toBe(1)
    expect(blocks[0]).toContain('第一段')
    expect(blocks[0]).toContain('第二段')
  })

  it('跨空行的列表仍留在同一块里', () => {
    const text = '开场\n\n- a\n\n- b\n\n收尾'
    const chunks = chunksOf(text)
    expect(chunks.join('')).toBe(text)
    // 开场 / 列表 / 收尾 三块；列表没有被空行拆成两块
    expect(chunks.length).toBe(3)
    expect(chunks[1]).toContain('- a')
    expect(chunks[1]).toContain('- b')
  })

  it('跨空行的引用属于同一个块', () => {
    const text = 'a\n\n> 第一段\n\n> 第二段\n\nb'
    const chunks = chunksOf(text)
    expect(chunks.length).toBe(3)
    expect(chunks[1]).toContain('第一段')
    expect(chunks[1]).toContain('第二段')
  })

  it('空文本返回一个空块', () => {
    expect(chunksOf('')).toEqual([''])
  })

  it('按标题切分普通长文', () => {
    const text = '第一段正文\n\n## 小节\n\n第二段正文\n'
    const chunks = chunksOf(text)
    expect(chunks.join('')).toBe(text)
    expect(chunks.length).toBe(3)
  })

  it('切块后的渲染结果与整篇一致（块间空白除外）', () => {
    const text = [
      '# 标题',
      '',
      '第一段，带 **加粗** 和 `code`。',
      '',
      '- 列表一',
      '',
      '- 列表二',
      '',
      '> 引用一',
      '',
      '> 引用二',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '```js',
      'const x = 1',
      '',
      'const y = 2',
      '```',
      '',
      '结尾段落。'
    ].join('\n')
    const render = (source) =>
      renderToStaticMarkup(
        React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, source)
      )
    const normalize = (html) => html.replace(/>\s+</g, '><').trim()
    const full = normalize(render(text))
    const chunked = chunksOf(text).map(render).map(normalize).join('')
    expect(chunked).toBe(full)
  })
})
