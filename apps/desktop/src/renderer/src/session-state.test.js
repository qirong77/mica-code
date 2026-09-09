import { describe, expect, it } from 'bun:test'
import { buildInboxItems, liveSessionRowState } from './session-state'

describe('liveSessionRowState', () => {
  it('only reports activity received from the current app process', () => {
    expect(liveSessionRowState({ persistedTurnState: 'running' })).toBeNull()
    expect(liveSessionRowState({ notificationState: { unread: true, running: false } })).toBe(
      'unread'
    )
    expect(liveSessionRowState({ notificationState: { unread: false, running: true } })).toBe(
      'running'
    )
    expect(liveSessionRowState({ notificationState: { unread: true, running: true } })).toBe(
      'running'
    )
    expect(liveSessionRowState({ notificationState: null })).toBeNull()
  })
})

describe('buildInboxItems', () => {
  const sessions = [
    { id: 's1', title: 'done' },
    { id: 's2', title: 'running' }
  ]

  it('only lists unread results and ignores running work', () => {
    const items = buildInboxItems({
      sessions,
      openBySession: { s1: 'node-1', s2: 'node-2' },
      unread: {
        'node-1': { unread: true, running: false, lastEventAt: 10 },
        'node-2': { unread: false, running: true, lastEventAt: 20 }
      }
    })
    expect(items.map((item) => item.session.id)).toEqual(['s1'])
  })

  it('keeps an unread result while its terminal runs a new command', () => {
    const items = buildInboxItems({
      sessions,
      openBySession: { s2: 'node-2' },
      unread: { 'node-2': { unread: true, running: true, lastEventAt: 5 } }
    })
    expect(items).toHaveLength(1)
    expect(items[0].state.running).toBe(true)
  })

  it('lists unread drafts and sorts by the latest event', () => {
    const items = buildInboxItems({
      sessions,
      draftTabs: [{ id: 'draft-1', text: 'new chat' }],
      openBySession: { s1: 'node-1' },
      unread: {
        'node-1': { unread: true, lastEventAt: 1 },
        'draft-1': { unread: true, lastEventAt: 2 }
      }
    })
    expect(items.map((item) => item.key)).toEqual(['draft-1', 'node-1'])
  })

  it('ignores sessions that are not open in this app process', () => {
    const items = buildInboxItems({
      sessions,
      openBySession: {},
      unread: { 'node-1': { unread: true } }
    })
    expect(items).toEqual([])
  })
})
