import { describe, expect, it } from 'bun:test'
import { appendRunStartedMessage } from './ChatView'

const user = (id, text) => ({ id, kind: 'message', role: 'user', text, done: true })
const assistant = (id, text) => ({ id, kind: 'message', role: 'assistant', text, done: true })

describe('appendRunStartedMessage', () => {
  it('appends the user message of a host-initiated turn (scheduled task)', () => {
    const messages = [user('p1', '写个测试'), assistant('a1', '好的')]

    const next = appendRunStartedMessage(messages, {
      prompt: '定时任务内容',
      clientMessageId: 'loop:term-default:2'
    })

    expect(next).toHaveLength(3)
    expect(next.at(-1)).toEqual({
      id: 'loop:term-default:2',
      kind: 'message',
      role: 'user',
      text: '定时任务内容',
      done: true
    })
  })

  it('keeps every round of a repeated task visible', () => {
    // 定时任务每一轮的文本都一样：不能按文本全局去重，否则第二轮起用户行消失。
    const afterFirst = appendRunStartedMessage([assistant('a1', '第 1 次回答')], {
      prompt: '定时任务内容',
      clientMessageId: 'loop:n:2'
    })
    const afterSecond = appendRunStartedMessage([...afterFirst, assistant('a2', '第 2 次回答')], {
      prompt: '定时任务内容',
      clientMessageId: 'loop:n:3'
    })

    expect(afterSecond.filter((message) => message.role === 'user').map((m) => m.id)).toEqual([
      'loop:n:2',
      'loop:n:3'
    ])
  })

  it('is idempotent when this page already inserted the optimistic row', () => {
    const messages = [assistant('a1', '上一轮回答'), user('msg-1', '你好')]

    const next = appendRunStartedMessage(messages, {
      prompt: '你好',
      clientMessageId: 'msg-1'
    })

    expect(next).toBe(messages)
  })

  it('does not duplicate a queued or edited row that still sits at the tail', () => {
    const queued = [assistant('a1', '上一轮回答'), { ...user('msg-2', '排队内容'), queued: true }]

    expect(appendRunStartedMessage(queued, { prompt: '排队内容' })).toBe(queued)

    const edited = [user('history-session-0', '改过的内容')]
    expect(appendRunStartedMessage(edited, { prompt: '改过的内容' })).toBe(edited)
  })

  it('ignores notices and tool rows when looking for the tail turn message', () => {
    const messages = [
      user('msg-1', '问题'),
      assistant('a1', '回答'),
      { id: 'n1', kind: 'notice', role: 'notice', text: '已压缩上下文' },
      { id: 't1', kind: 'tool', role: 'tool', text: '' }
    ]

    const next = appendRunStartedMessage(messages, { prompt: '新的一轮' })

    expect(next).toHaveLength(5)
    expect(next.at(-1).role).toBe('user')
  })

  it('ignores image placeholders and surrounding whitespace when matching', () => {
    const messages = [user('msg-1', '[图片] 看看这个')]

    expect(appendRunStartedMessage(messages, { prompt: ' 看看这个 ' })).toBe(messages)
  })

  it('returns the same list for a blank prompt', () => {
    const messages = [assistant('a1', '回答')]

    expect(appendRunStartedMessage(messages, { prompt: '   ' })).toBe(messages)
    expect(appendRunStartedMessage(messages, null)).toBe(messages)
  })
})
