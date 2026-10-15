import { describe, expect, it } from 'bun:test'
import {
  buildQuoteBlock,
  findQuoteBlocks,
  quoteIntoDraft,
  removeQuoteBlock,
  splitQuoteSegments
} from './quote-message'

describe('引用对话', () => {
  it('生成带署名的引用块', () => {
    expect(buildQuoteBlock({ role: 'user', text: '原文' })).toBe('引用对话（我）：\n```\n原文\n```')
    expect(buildQuoteBlock({ role: 'assistant', text: '好的' })).toBe(
      '引用对话（模型）：\n```\n好的\n```'
    )
  })

  it('插进空草稿时块独立成段，光标落在块后的空行上', () => {
    const { text, caret } = quoteIntoDraft('', 0, { role: 'user', text: '第一行\n第二行' })
    expect(text).toBe('引用对话（我）：\n```\n第一行\n第二行\n```\n\n')
    expect(caret).toBe(text.length)
  })

  it('已有正文时另起一段插进去', () => {
    const draft = '帮我看下'
    const { text } = quoteIntoDraft(draft, draft.length, { role: 'assistant', text: '好的' })
    expect(text).toBe('帮我看下\n\n引用对话（模型）：\n```\n好的\n```\n\n')
  })

  it('同一条消息重复引用不重复插入，只把光标移到已有块后面', () => {
    const first = quoteIntoDraft('', 0, { role: 'user', text: '再来一次' })
    const second = quoteIntoDraft(first.text, 0, { role: 'user', text: '再来一次' })
    expect(second.text).toBe(first.text)
    expect(second.text.match(/引用对话（我）：/g)).toHaveLength(1)
    expect(second.caret).toBeGreaterThan(0)
  })

  it('不同消息各插一段', () => {
    const a = quoteIntoDraft('', 0, { role: 'user', text: 'A' })
    const b = quoteIntoDraft(a.text, a.caret, { role: 'assistant', text: 'B' })
    expect(b.text.match(/引用对话（/g)).toHaveLength(2)
  })

  it('正文里的泳道围栏更长，引用一段 markdown 不会撕开后面的内容', () => {
    const { text } = quoteIntoDraft('', 0, { role: 'assistant', text: '```js\ncode\n```' })
    expect(text).toContain('````\n```js\ncode\n```\n````')
  })

  it('图片引用降级成 [图片]，不重传整张图', () => {
    const { text } = quoteIntoDraft('', 0, { role: 'user', text: '看图 [Image](a.png)' })
    expect(text).toContain('[图片]')
    expect(text).not.toContain('a.png')
  })

  it('对话流按引用块分段，原文一字不改', () => {
    const quoted = quoteIntoDraft('', 0, { role: 'user', text: '原文' }).text
    const segments = splitQuoteSegments(`${quoted}我的问题`)
    expect(segments.map((segment) => segment.type)).toEqual(['quote', 'text'])
    expect(segments[0].label).toBe('我')
    expect(segments[0].text).toBe('原文')
    // 分隔用的空行归在文本段里，由渲染层收敛掉
    expect(segments[1].text.trim()).toBe('我的问题')
  })

  it('删掉引用块后只留下用户写的正文', () => {
    const quoted = quoteIntoDraft('', 0, { role: 'user', text: '原文' }).text
    const withQuestion = `${quoted}我的问题`
    const blocks = findQuoteBlocks(withQuestion)
    expect(blocks).toHaveLength(1)
    expect(removeQuoteBlock(withQuestion, blocks[0])).toBe('我的问题')
  })
})
