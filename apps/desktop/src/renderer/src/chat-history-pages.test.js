import { describe, expect, test } from 'bun:test'
import { historyPage } from '../../host/chat-history-page'
import { historyBeforeRunReplay, historyPageMessages, canReuseVisualTranscript } from './ChatView'
import { restoreChatNotices } from './chat-notices'
import {
  canPrependHistoryPage,
  historyPageRequestStatus,
  historyPageState,
  noticeNeedsHistoryResync,
  prependedScrollTop
} from './chat-history-pages'

const rows = Array.from({ length: 100 }, (_, i) => [
  { role: 'user', text: `prompt ${i}` },
  { role: 'notice', text: `notice ${i}` },
  { role: 'assistant', text: `reply ${i}` }
]).flat()

describe('paged transcript restoration', () => {
  test('reloads slots when a replacement removes a notice from an unloaded prefix', () => {
    const a = { role: 'notice', command: 'a', status: 'success', text: 'old A' }
    const b = { role: 'notice', command: 'b', status: 'success', text: 'B must survive' }
    const original = [a, ...rows.filter((row) => row.role !== 'notice'), b]
    const page = historyPage(original)
    expect(page.noticeOffset).toBe(1)
    const replacement = {
      type: 'notice',
      command: 'a',
      replace: true,
      noticeIndex: 1,
      status: 'running',
      text: 'new A'
    }
    expect(noticeNeedsHistoryResync(page, replacement)).toBe(true)
    // Host has already persisted removal of A. A bounded refresh restores B's true slot.
    const current = original.slice(1).concat({ role: 'notice', ...replacement })
    const refreshed = historyPage(current, { from: page.startCursor })
    expect(refreshed.reset).toBe(true)
    const restored = restoreChatNotices(
      historyPageMessages(refreshed, 's'),
      [],
      [{ ...replacement, replace: false, status: 'success', text: 'A done' }]
    )
    const notices = restored.filter((row) => row.kind === 'notice')
    expect(notices.map((row) => [row.command, row.noticeIndex, row.text])).toEqual([
      ['b', 0, 'B must survive'],
      ['a', 1, 'A done']
    ])
    expect(noticeNeedsHistoryResync({ start: 0 }, replacement)).toBe(false)
    expect(noticeNeedsHistoryResync(page, { ...replacement, replace: false })).toBe(false)
  })
  test('prepends older records while retaining live tool/text identities and global notice slots', () => {
    const page = historyPage(rows)
    const recent = historyPageMessages(page, 'session')
    const streamed = {
      id: 'live',
      kind: 'message',
      role: 'assistant',
      text: 'live delta',
      done: false
    }
    const tool = { id: 'tool', kind: 'tool', text: 'running' }
    const current = [...recent, streamed, tool]
    const older = historyPage(rows, { before: page.nextBefore })
    expect(canPrependHistoryPage(page, older)).toBe(true)
    const combined = [...historyPageMessages(older, 'session'), ...current]
    expect(combined.at(-1)).toBe(tool)
    expect(combined.at(-2)).toBe(streamed)
    expect(new Set(combined.map((row) => row.id)).size).toBe(combined.length)
    const notices = combined.filter((row) => row.kind === 'notice')
    expect(notices[0].noticeIndex).toBe(older.noticeOffset)
    expect(notices.at(-1).noticeIndex).toBe(99)
    const updated = restoreChatNotices(
      combined,
      [],
      [{ type: 'notice', noticeIndex: 99, text: 'finished digest', status: 'success' }]
    )
    expect(updated).toHaveLength(combined.length)
    expect(updated.filter((row) => row.kind === 'notice').at(-1).text).toBe('finished digest')
  })

  test('latest-turn replay still trims at the user prompt across an oversized page', () => {
    const active = [
      { role: 'user', text: 'active question' },
      ...Array.from({ length: 100 }, (_, i) => ({ role: 'assistant', text: `step ${i}` }))
    ]
    const persisted = historyPageMessages(historyPage([...rows, ...active]), 's')
    expect(historyBeforeRunReplay(persisted, 'active question').map((row) => row.text)).toEqual([
      'active question'
    ])
  })

  test('loaded ranges can be handed back and refreshed without losing cached visual tools', () => {
    const page = historyPage(rows)
    const older = historyPage(rows, { before: page.nextBefore })
    const visual = [...historyPageMessages(older, 's'), ...historyPageMessages(page, 's')]
    visual.splice(2, 0, { kind: 'tool', id: 'cached-tool', text: 'detail' })
    const state = historyPageState({ ...older, end: page.end })
    expect(state).not.toHaveProperty('rows')
    const restored = historyPageMessages(historyPage(rows, { from: state.startCursor }), 's')
    expect(canReuseVisualTranscript(visual, restored)).toBe(true)
  })

  test('explicit full-text expansion includes a match outside the recent page', () => {
    const page = historyPage(rows)
    const older = historyPage(rows, { before: page.nextBefore, all: true })
    const complete = [...historyPageMessages(older, 's'), ...historyPageMessages(page, 's')]
    expect(complete.some((row) => row.text === 'prompt 0')).toBe(true)
    expect(complete).toHaveLength(rows.length)
  })

  test('rejects stale node, hidden view, reconnected range and in-progress restore responses', () => {
    const page = historyPageState(historyPage(rows))
    const request = { page, sessionId: 'a', generation: 1, mutation: 0 }
    const current = { ...request, visible: true, restoring: false }
    const older = historyPage(rows, { before: page.nextBefore })
    expect(historyPageRequestStatus(request, current, older)).toBe('prepend')
    for (const changed of [
      { sessionId: 'b' },
      { generation: 2 },
      { page: { ...page } },
      { visible: false },
      { restoring: true }
    ])
      expect(historyPageRequestStatus(request, { ...current, ...changed }, older)).toBe('stale')
    expect(historyPageRequestStatus(request, { ...current, mutation: 1 }, older)).toBe('resync')
    expect(historyPageRequestStatus(request, current, { ...older, reset: true })).toBe('resync')
    expect(historyPageRequestStatus(request, current, { ...older, end: page.start - 1 })).toBe(
      'resync'
    )
  })

  test('preserves viewport position by the actual prepended height', () => {
    expect(prependedScrollTop({ top: 120, height: 1000 }, 1600)).toBe(720)
    expect(prependedScrollTop({ top: 0, height: 1000 }, 1500)).toBe(500)
  })
})
