import { describe, expect, it } from 'bun:test'
import { resolveQueueRecall } from './chat-recall'

describe('resolveQueueRecall', () => {
  it('restores the draft when the host took the message back', () => {
    expect(
      resolveQueueRecall({ id: 'msg-1', pending: false, ok: true, queuedItems: [], runActive: true })
    ).toBe('restore')
  })

  // host 明确说队列里已经没有它、turn 还在跑：确认通知丢了也说明已经注入，
  // 这一行必须回到对话里，不能继续挂在排队区。
  it('marks an unconfirmed row as sent once the host reports it is gone', () => {
    expect(
      resolveQueueRecall({
        id: 'msg-1',
        pending: true,
        ok: false,
        queuedItems: [],
        runActive: true
      })
    ).toBe('sent')
  })

  it('keeps the row while the host still holds it, even for a pending row', () => {
    expect(
      resolveQueueRecall({
        id: 'msg-1',
        pending: true,
        ok: false,
        queuedItems: [{ id: 'msg-1', text: 'hi' }],
        runActive: true
      })
    ).toBe('keep')
  })

  // turn 还在跑、host 队列里已经没有它：这条消息开始发送了，行要回到对话里，
  // 不能继续挂在排队区。
  it('marks the row as sent while a turn is still running', () => {
    expect(
      resolveQueueRecall({ id: 'msg-1', pending: false, ok: false, queuedItems: [], runActive: true })
    ).toBe('sent')
  })

  // 没有 turn 在跑、host 队列也是空的：这条消息根本没发出去，交回输入框，
  // 而不是假装已经发送。
  it('restores an idle run whose queue no longer holds the message', () => {
    expect(
      resolveQueueRecall({
        id: 'msg-1',
        pending: false,
        ok: false,
        queuedItems: [],
        runActive: false
      })
    ).toBe('restore')
  })

  // 拿不到队列快照时不能假设消息发出去了。
  it('keeps a confirmed row when the host reported no queue snapshot', () => {
    expect(
      resolveQueueRecall({ id: 'msg-1', pending: false, ok: false, queuedItems: null, runActive: false })
    ).toBe('keep')
  })
})
