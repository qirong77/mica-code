import { describe, expect, it } from 'bun:test'

import {
  CONVERSATION_ANCHOR_TOLERANCE,
  canGoToPreviousConversation,
  conversationAnchorIndex,
  conversationNavTarget
} from './chat-conversation-nav.js'

// 四条用户消息在滚动坐标系里的位置
const TOPS = [5, 300, 700, 1200]

describe('conversationAnchorIndex', () => {
  it('停在最顶上时上方什么也没有', () => {
    expect(conversationAnchorIndex(TOPS, 0)).toBe(0)
  })

  it('取视野顶部及上方最后一条', () => {
    expect(conversationAnchorIndex(TOPS, 400)).toBe(1)
    expect(conversationAnchorIndex(TOPS, 300)).toBe(1)
  })

  it('刚好压在边缘上也算这一条在顶部（容差内）', () => {
    expect(conversationAnchorIndex(TOPS, 300 - CONVERSATION_ANCHOR_TOLERANCE + 1)).toBe(1)
    expect(conversationAnchorIndex(TOPS, 300 - CONVERSATION_ANCHOR_TOLERANCE - 1)).toBe(0)
  })

  it('滚过最后一条之后锚点停在最后一条，不会越界', () => {
    expect(conversationAnchorIndex(TOPS, 99999)).toBe(TOPS.length - 1)
  })

  it('没有用户消息时是 -1', () => {
    expect(conversationAnchorIndex([], 500)).toBe(-1)
  })
})

describe('canGoToPreviousConversation', () => {
  it('还没滚过第二条时没有上一个', () => {
    expect(canGoToPreviousConversation(TOPS, 0)).toBe(false)
    expect(canGoToPreviousConversation(TOPS.slice(0, 2), 0)).toBe(false)
  })

  it('滚过第二条之后有上一个（只看前两条也成立）', () => {
    expect(canGoToPreviousConversation(TOPS, 400)).toBe(true)
    expect(canGoToPreviousConversation(TOPS.slice(0, 2), 400)).toBe(true)
  })

  it('只有一轮对话时永远没有上一个', () => {
    expect(canGoToPreviousConversation([7], 900)).toBe(false)
    expect(canGoToPreviousConversation([], 900)).toBe(false)
  })
})

describe('conversationNavTarget', () => {
  it('上一个对话 = 锚点上面那一条', () => {
    expect(conversationNavTarget(TOPS, 400, 'previous')).toEqual({
      kind: 'message',
      index: 0,
      top: 5
    })
    expect(conversationNavTarget(TOPS, 1300, 'previous')).toEqual({
      kind: 'message',
      index: 2,
      top: 700
    })
  })

  it('下方没有对话时回落到最新消息', () => {
    expect(conversationNavTarget(TOPS, 1300, 'next')).toEqual({ kind: 'bottom' })
  })

  it('下一个对话 = 锚点下面那一条', () => {
    expect(conversationNavTarget(TOPS, 0, 'next')).toEqual({
      kind: 'message',
      index: 1,
      top: 300
    })
  })

  it('上方没有对话时上一个什么都不做（而不是跳到开头）', () => {
    expect(conversationNavTarget(TOPS, 0, 'previous')).toEqual({ kind: 'none' })
    expect(conversationNavTarget([], 0, 'previous')).toEqual({ kind: 'none' })
  })

  it('一条对话都没有时「下一个」就是回到底部', () => {
    expect(conversationNavTarget([], 0, 'next')).toEqual({ kind: 'bottom' })
  })
})
