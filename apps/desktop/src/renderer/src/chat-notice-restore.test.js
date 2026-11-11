import { describe, expect, test } from 'bun:test'
import { restoreChatNotices } from './chat-notices'
import { historyBeforeRunReplay, historyMessages, mergeReplayEvents } from './ChatView'

describe('persisted notice restoration', () => {
  test('retains a finished digest after reply replay without duplicate rows', () => {
    const rows = historyMessages(
      [
        { role: 'user', text: 'question' },
        { role: 'assistant', text: 'long reply' },
        { role: 'notice', text: 'summary', variant: 'digest', command: 'digest:1', status: 'info' }
      ],
      's'
    )
    const replayed = [...historyBeforeRunReplay(rows, 'question'), rows[1]]
    const restored = restoreChatNotices(replayed, rows)
    expect(restored.map((row) => row.text)).toEqual(['question', 'long reply', 'summary'])
    expect(restored[2].noticeIndex).toBe(0)
    expect(restoreChatNotices(restored, rows)).toEqual(restored)
  })

  test('does not skip a direct notice received before the latest buffered turn delta', () => {
    const update = {
      type: 'notice',
      text: 'summary',
      noticeIndex: 0,
      status: 'info',
      command: 'digest:1'
    }
    const merged = mergeReplayEvents(
      [{ sequence: 20, event: { type: 'step_finish' } }],
      [{ sequence: 19, event: update }]
    )
    expect(merged).toContain(update)
    const rows = historyMessages(
      [{ role: 'notice', text: 'waiting', command: 'digest:1', status: 'running' }],
      's'
    )
    const restored = restoreChatNotices(rows, rows, merged)
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({ text: 'summary', status: 'info', noticeIndex: 0 })
  })
})
