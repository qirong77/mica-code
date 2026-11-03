import { describe, expect, it } from 'bun:test'
import {
  collapseTerminalStates,
  normalizeTerminalState,
  terminalNodeId,
  unreadTerminalIds
} from './notify-state'

describe('terminalNodeId', () => {
  it('strips the pane suffix so PTY states line up with the terminal entry', () => {
    expect(terminalNodeId('rt-1:terminal')).toBe('rt-1')
    expect(terminalNodeId('editor-abc-1:terminal')).toBe('editor-abc-1')
    expect(terminalNodeId('rt-1')).toBe('rt-1')
    expect(terminalNodeId('')).toBe(null)
    expect(terminalNodeId(null)).toBe(null)
  })
})

describe('collapseTerminalStates', () => {
  it('merges panes of one entry into a single row state', () => {
    const states = collapseTerminalStates({
      'rt-1:terminal': {
        unread: true,
        running: false,
        processRunning: false,
        lastType: 'turn.completed',
        lastEventAt: 100
      },
      'rt-1:mica': {
        unread: false,
        running: true,
        processRunning: false,
        lastType: 'turn.started',
        lastEventAt: 200
      }
    })
    expect(states['rt-1']).toEqual({
      unread: true,
      running: true,
      processRunning: false,
      // 最近一次事件决定红点与未读短闪的 key
      lastType: 'turn.started',
      lastEventAt: 200
    })
  })

  it('keeps the newest event type so a failed turn still paints the row red', () => {
    const states = collapseTerminalStates({
      'rt-1:terminal': {
        unread: false,
        running: false,
        lastType: 'turn.error',
        lastEventAt: 300
      },
      'rt-2:terminal': {
        unread: true,
        running: false,
        lastType: 'turn.completed',
        lastEventAt: 100
      }
    })
    expect(states['rt-1'].lastType).toBe('turn.error')
    expect(states['rt-2']).toMatchObject({ unread: true, lastType: 'turn.completed' })
  })
})

describe('unreadTerminalIds', () => {
  const states = {
    'rt-1:terminal': { unread: true, running: false, lastEventAt: 10 },
    'rt-1:mica': { unread: false, running: true, lastEventAt: 20 },
    'rt-2:terminal': { unread: false, running: false, lastEventAt: 30 },
    'rt-3:terminal': { unread: true, running: false, lastEventAt: 40 }
  }

  it('clears every unread pane of the entry the user just looked at', () => {
    expect(unreadTerminalIds(states, 'rt-1')).toEqual(['rt-1:terminal'])
    expect(unreadTerminalIds(states, 'rt-3')).toEqual(['rt-3:terminal'])
  })

  it('accepts the PTY id itself', () => {
    expect(unreadTerminalIds(states, 'rt-1:terminal')).toEqual(['rt-1:terminal'])
  })

  it('does not touch entries whose panes are already read, or unrelated ones', () => {
    expect(unreadTerminalIds(states, 'rt-2')).toEqual([])
    expect(unreadTerminalIds(states, 'rt')).toEqual([])
    expect(unreadTerminalIds(states, null)).toEqual([])
  })
})

describe('normalizeTerminalState', () => {
  it('always exposes the fields the UI reads', () => {
    expect(normalizeTerminalState({ running: true })).toMatchObject({
      unread: false,
      running: true,
      processRunning: false,
      lastType: null
    })
  })
})
