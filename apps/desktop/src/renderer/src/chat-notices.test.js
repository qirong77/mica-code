import { describe, expect, test } from 'bun:test'
import { restoreChatNotices, upsertChatNotice } from './chat-notices'

const notice = (id, status, command = 'digest:1') => ({
  id,
  kind: 'notice',
  role: 'notice',
  text: status,
  variant: 'digest',
  command,
  status
})

describe('upsertChatNotice', () => {
  test('inserts progress immediately and finishes in place without touching a live reply', () => {
    const answer = { id: 'answer', kind: 'message', text: 'original', done: false }
    const running = upsertChatNotice([answer], notice('n1', 'running'))
    expect(running[1].status).toBe('running')
    const nextReply = { id: 'next', kind: 'message', text: 'streaming', done: false }
    const done = upsertChatNotice([...running, nextReply], notice('n2', 'success'))
    expect(done).toEqual([answer, { ...notice('n1', 'success') }, nextReply])
    expect(done[0]).toBe(answer)
    expect(done[2]).toBe(nextReply)
  })

  test('keeps prior results and settles failed or cancelled progress in the right slot', () => {
    const old = notice('old', 'success', 'digest:old')
    for (const status of ['warning', 'error']) {
      const done = upsertChatNotice([old, notice('pending', 'running')], notice('done', status))
      expect(done).toEqual([old, notice('pending', status)])
    }
    expect(upsertChatNotice([old], notice('new', 'success'))).toHaveLength(2)
  })

  test('preserves retry updates without status and explicit replace semantics', () => {
    const row = notice('retry', '', '/retry')
    const updated = upsertChatNotice([row], { ...row, id: 'new', text: 'retrying' })
    expect(updated).toEqual([{ ...row, text: 'retrying' }])
    const other = notice('other', 'success', 'other')
    expect(
      upsertChatNotice([row, other], notice('new', 'info', '/retry'), { replace: true })
    ).toEqual([other, notice('new', 'info', '/retry')])
  })

  test('keeps a running row id and position even when finish asks to replace', () => {
    const tail = { id: 'tail', kind: 'message', text: 'live' }
    expect(
      upsertChatNotice([notice('pending', 'running'), tail], notice('done', 'info'), {
        replace: true
      })
    ).toEqual([notice('pending', 'info'), tail])
  })

  test('restored slots make late completed notifications idempotent without losing repeated results', () => {
    const restored = { ...notice('history', 'info'), noticeIndex: 0 }
    const late = { ...notice('late', 'info'), noticeIndex: 0 }
    expect(upsertChatNotice([restored], late)).toEqual([restored])
    const repeated = { ...notice('next', 'info'), noticeIndex: 1 }
    expect(upsertChatNotice([restored], repeated)).toEqual([restored, repeated])
  })

  test('restores a saved summary after replayed reply and keeps the latest pending status', () => {
    const answer = { id: 'answer', kind: 'message', text: 'reply' }
    const running = { ...notice('saved', 'running'), noticeIndex: 0 }
    const update = {
      type: 'notice',
      text: 'summary',
      variant: 'digest',
      command: 'digest:1',
      status: 'info',
      noticeIndex: 0
    }
    const next = restoreChatNotices([answer], [answer, running], [update])
    expect(next).toEqual([answer, { ...running, status: 'info', text: 'summary' }])
    expect(restoreChatNotices(next, [answer, running], [update])).toEqual(next)
    expect(restoreChatNotices([answer], [answer, { ...running, status: 'info' }])).toHaveLength(2)
  })
})
