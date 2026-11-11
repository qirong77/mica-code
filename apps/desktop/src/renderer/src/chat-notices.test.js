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

  test('replacing a saved command reindexes surviving notices before using the new slot', () => {
    const old = { ...notice('old', 'info', 'sync'), noticeIndex: 0 }
    const answer = { id: 'answer', kind: 'message', text: 'reply' }
    const other = { ...notice('other', 'info', 'digest:other'), noticeIndex: 1 }
    const tail = { ...notice('tail', 'info', 'digest:tail'), noticeIndex: 2 }
    const latest = { ...notice('latest', 'info', 'sync'), noticeIndex: 2 }
    const replaced = upsertChatNotice([old, answer, other, tail], latest, { replace: true })
    expect(replaced).toEqual([
      answer,
      { ...other, noticeIndex: 0 },
      { ...tail, noticeIndex: 1 },
      latest
    ])
    expect(upsertChatNotice(replaced, { ...tail, text: 'updated', noticeIndex: 1 })).toEqual([
      answer,
      { ...other, noticeIndex: 0 },
      { ...tail, text: 'updated', noticeIndex: 1 },
      latest
    ])
    expect(upsertChatNotice(replaced, latest, { replace: true })).toEqual(replaced)
    const live = { id: 'live', kind: 'message', text: 'streaming', done: false }
    expect(upsertChatNotice([...replaced, live], latest, { replace: true })).toEqual([
      ...replaced,
      live
    ])
  })

  test('removes all completed copies while keeping local notices outside the persisted index', () => {
    const first = { ...notice('first', 'info', 'sync'), noticeIndex: 0 }
    const second = { ...notice('second', 'info', 'sync'), noticeIndex: 2 }
    const local = notice('local', 'info', 'local')
    const other = { ...notice('other', 'info'), noticeIndex: 1 }
    const latest = { ...notice('latest', 'running', 'sync'), noticeIndex: 1 }
    expect(upsertChatNotice([first, local, other, second], latest, { replace: true })).toEqual([
      local,
      { ...other, noticeIndex: 0 },
      latest
    ])
  })

  test('keeps row IDs unique when a replacement reuses another surviving notice index', () => {
    const saved = [
      { ...notice('notice-0', 'info', 'sync'), noticeIndex: 0 },
      { ...notice('notice-1', 'info', 'digest:a'), noticeIndex: 1 },
      { ...notice('notice-2', 'info', 'digest:b'), noticeIndex: 2 }
    ]
    const update = {
      type: 'notice',
      noticeIndex: 2,
      text: 'new sync',
      command: 'sync',
      status: 'info',
      replace: true
    }
    const restored = restoreChatNotices(saved, [], [update])
    expect(new Set(restored.map((row) => row.id)).size).toBe(3)
    expect(restored.slice(0, 2).map((row) => row.id)).toEqual(['notice-1', 'notice-2'])
    expect(restored.map((row) => row.noticeIndex)).toEqual([0, 1, 2])
    expect(restoreChatNotices(restored, [], [update])).toEqual(restored)
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
