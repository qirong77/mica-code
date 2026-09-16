import { describe, expect, it } from 'bun:test'
import {
  collectGroupStates,
  liveSessionRowState,
  mergeRowStates,
  nextDraftMarkers,
  runningTerminalSessions
} from './session-state'

describe('nextDraftMarkers', () => {
  it('adds and removes a node as its unsent text appears and goes away', () => {
    const empty = new Set()
    const withA = nextDraftMarkers(empty, 'a', 'hello')
    expect([...withA]).toEqual(['a'])
    expect([...nextDraftMarkers(withA, 'a', '')]).toEqual([])
    // 空白文本不算未发送内容（输入几个空格就亮图标没有意义）
    expect([...nextDraftMarkers(empty, 'a', '   \n')]).toEqual([])
  })

  it('keeps the same reference when nothing changes, so the sidebar does not rerender', () => {
    const markers = nextDraftMarkers(new Set(), 'a', 'x')
    expect(nextDraftMarkers(markers, 'a', 'yy')).toBe(markers)
    expect(nextDraftMarkers(markers, 'b', '')).toBe(markers)
    expect(nextDraftMarkers(markers, null, 'x')).toBe(markers)
  })

  it('tracks one node without touching the others', () => {
    const markers = nextDraftMarkers(nextDraftMarkers(new Set(), 'a', 'x'), 'b', 'y')
    expect([...nextDraftMarkers(markers, 'a', '')]).toEqual(['b'])
  })
})

describe('runningTerminalSessions', () => {
  const terms = [
    { id: 'rt-1', sessionId: 's1' },
    { id: 'rt-2', sessionId: 's1' },
    { id: 'rt-3', sessionId: 's2' },
    { id: 'rt-4', sessionId: null }
  ]

  it('marks a session when one of its terminals runs a foreground process', () => {
    expect(runningTerminalSessions(terms, { 'rt-2': { processRunning: true } })).toEqual(
      new Set(['s1'])
    )
  })

  it('ignores agent turns and terminals without an owning session', () => {
    expect(
      runningTerminalSessions(terms, {
        'rt-3': { running: true, agentRunning: true, processRunning: false },
        'rt-4': { processRunning: true }
      })
    ).toEqual(new Set())
  })

  it('drops the mark once the process exits', () => {
    expect(
      runningTerminalSessions([{ id: 'rt-1', sessionId: 's1' }], {
        'rt-1': { processRunning: false }
      })
    ).toEqual(new Set())
  })
})

describe('liveSessionRowState', () => {
  it('only reports activity received from the current app process', () => {
    expect(liveSessionRowState({})).toBeNull()
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

  it('turns red when the last turn errored, before its result is read', () => {
    expect(
      liveSessionRowState({
        notificationState: { unread: true, running: false, lastType: 'turn.error' }
      })
    ).toBe('error')
    // 读过之后红点仍在：它是会话状态，不是未读徽标。
    expect(
      liveSessionRowState({
        notificationState: { unread: false, running: false, lastType: 'turn.error' }
      })
    ).toBe('error')
  })

  it('keeps a user-requested abort on the unread dot', () => {
    expect(
      liveSessionRowState({
        notificationState: { unread: true, running: false, lastType: 'turn.aborted' }
      })
    ).toBe('unread')
  })

  it('turns red for a session the host marked as interrupted', () => {
    expect(liveSessionRowState({ interrupted: true })).toBe('error')
    // running 只是没跑完的一种，恢复运行后绿点优先。
    expect(liveSessionRowState({ interrupted: true, notificationState: { running: true } })).toBe(
      'running'
    )
    // 红点比同一次事件带来的未读更值得看，不能被蓝色盖掉。
    expect(liveSessionRowState({ interrupted: true, notificationState: { unread: true } })).toBe(
      'error'
    )
  })

  it('breathes green for a turn another window or runtime is holding the lease for', () => {
    expect(liveSessionRowState({ remoteRunning: true })).toBe('running')
    // 别处正在跑比上一轮的错误更贴近现状：这条会话现在确实在动。
    expect(
      liveSessionRowState({ remoteRunning: true, notificationState: { lastType: 'turn.error' } })
    ).toBe('running')
    expect(liveSessionRowState({ remoteRunning: true, notificationState: { unread: true } })).toBe(
      'running'
    )
    expect(liveSessionRowState({ remoteRunning: false })).toBe(null)
  })
})

describe('mergeRowStates', () => {
  it('reports nothing when no row inside has anything to say', () => {
    expect(mergeRowStates([])).toBeNull()
    expect(mergeRowStates([null, undefined, null])).toBeNull()
  })

  it('ranks running above unread, same as the row dot', () => {
    expect(mergeRowStates(['unread', 'running'])).toBe('running')
    expect(mergeRowStates([null, 'unread', null])).toBe('unread')
  })

  it('never floats a failed turn up to a collapsed ancestor', () => {
    expect(mergeRowStates(['error'])).toBeNull()
    expect(mergeRowStates(['error', 'unread'])).toBe('unread')
    expect(mergeRowStates(['error', 'running'])).toBe('running')
  })
})

describe('collectGroupStates', () => {
  const projects = {
    groups: [
      { id: 'g1', name: 'A', parentId: null },
      { id: 'g2', name: 'B', parentId: 'g1' },
      { id: 'g3', name: 'C', parentId: null }
    ],
    assignments: {}
  }
  const row = (id, state) => ({ id, state })
  const stateOf = (item) => item.state

  it('merges the whole subtree so a collapsed parent can speak for hidden rows', () => {
    const states = collectGroupStates({
      projects,
      sessionsByGroup: new Map([
        ['g1', [row('s1', 'unread')]],
        ['g2', [row('s2', 'running')]],
        ['g3', [row('s3', 'error')]]
      ]),
      draftsByGroup: new Map(),
      stateOfSession: stateOf,
      stateOfDraft: stateOf
    })
    expect(states.get('g1')).toBe('running')
    expect(states.get('g2')).toBe('running')
    // 兄弟分组之间不互相污染，且失败会话不上浮到容器
    expect(states.get('g3')).toBeNull()
  })

  it('keeps empty groups empty instead of borrowing a sibling activity', () => {
    const states = collectGroupStates({
      projects,
      sessionsByGroup: new Map([['g1', [row('s1', 'running')]]]),
      draftsByGroup: new Map(),
      stateOfSession: stateOf,
      stateOfDraft: stateOf
    })
    expect(states.get('g2')).toBeNull()
    expect(states.get('g3')).toBeNull()
  })

  it('counts drafts in the group and asks the right callback for each kind', () => {
    const seen = []
    const states = collectGroupStates({
      projects,
      sessionsByGroup: new Map([['g1', [row('s1', null)]]]),
      draftsByGroup: new Map([['g1', [row('d1', 'unread')]]]),
      stateOfSession: (item) => {
        seen.push(`session:${item.id}`)
        return item.state
      },
      stateOfDraft: (item) => {
        seen.push(`draft:${item.id}`)
        return item.state
      }
    })
    expect(seen).toEqual(['session:s1', 'draft:d1'])
    expect(states.get('g1')).toBe('unread')
  })
})
