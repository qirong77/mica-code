import { describe, expect, it } from 'bun:test'

import { CHAT_COLLAPSE_LINES, canCollapseMessage, measureChatCollapse } from './chat-collapse.js'

describe('canCollapseMessage', () => {
  it('纯文本可以折叠', () => {
    expect(canCollapseMessage('很长的一段用户输入')).toBe(true)
  })

  it('带图片引用的消息不折叠，避免裁掉缩略图', () => {
    expect(canCollapseMessage('看看这张图\n[Image](~/.mica/images/a.png)')).toBe(false)
  })

  it('空消息不算可折叠', () => {
    expect(canCollapseMessage(undefined)).toBe(true)
  })
})

describe('measureChatCollapse', () => {
  const lineHeight = 16

  it(`正好 ${CHAT_COLLAPSE_LINES} 行时不折叠`, () => {
    expect(
      measureChatCollapse({ scrollHeight: lineHeight * CHAT_COLLAPSE_LINES, lineHeight })
    ).toEqual({
      collapsible: false,
      totalLines: CHAT_COLLAPSE_LINES
    })
  })

  it('超过 10 行时折叠，并给出总行数', () => {
    expect(measureChatCollapse({ scrollHeight: lineHeight * 10 + 5, lineHeight })).toEqual({
      collapsible: true,
      totalLines: 11
    })
  })

  it('行高不可用时按不折叠处理，不猜一个阈值', () => {
    expect(measureChatCollapse({ scrollHeight: 400, lineHeight: Number.NaN })).toEqual({
      collapsible: false,
      totalLines: 0
    })
    expect(measureChatCollapse({ scrollHeight: 400, lineHeight: 0 })).toEqual({
      collapsible: false,
      totalLines: 0
    })
  })
})
