import { describe, expect, it } from 'bun:test'
import { activeRightTermId, reclaimableRightTermIds, staleRightTermIds } from './right-terms'

describe('activeRightTermId', () => {
  const terms = [{ id: 'rt-1' }, { id: 'rt-2' }]

  it('keeps the terminal the user picked for this session', () => {
    expect(activeRightTermId(terms, 'rt-2')).toBe('rt-2')
  })

  it('falls back to the first terminal when the picked one is gone', () => {
    expect(activeRightTermId(terms, 'rt-9')).toBe('rt-1')
    expect(activeRightTermId(terms, null)).toBe('rt-1')
  })

  it('has nothing to show for a session without terminals', () => {
    expect(activeRightTermId([], 'rt-1')).toBeNull()
  })
})

describe('staleRightTermIds', () => {
  const terms = [
    { id: 'rt-1', cwd: '/old' },
    { id: 'rt-2', cwd: '/new' }
  ]

  it('reopens only the terminals left behind in the previous directory', () => {
    expect(staleRightTermIds(terms, '/new', {})).toEqual(['rt-1'])
  })

  it('leaves terminals alone when the session path did not change', () => {
    expect(staleRightTermIds([{ id: 'rt-1', cwd: '/new' }], '/new', {})).toEqual([])
  })

  it('never touches a terminal with a foreground process', () => {
    expect(staleRightTermIds(terms, '/new', { 'rt-1': { processRunning: true } })).toEqual([])
    // 只有 Mica turn 在跑不算：那是会话自己的事，终端前台还是空闲的。
    expect(
      staleRightTermIds(terms, '/new', { 'rt-1': { running: true, agentRunning: true } })
    ).toEqual(['rt-1'])
  })

  it('does nothing without a target directory', () => {
    expect(staleRightTermIds(terms, null, {})).toEqual([])
    expect(staleRightTermIds(terms, '', {})).toEqual([])
    expect(staleRightTermIds([], '/new', {})).toEqual([])
  })
})

describe('reclaimableRightTermIds', () => {
  const hour = 60 * 60 * 1000
  const now = 100 * hour
  const terms = [{ id: 'rt-1' }, { id: 'rt-2' }]

  it('reclaims terminals of a session nobody touched for 8h', () => {
    expect(
      reclaimableRightTermIds({ terms, lastUsedAt: now - 9 * hour, activityAt: {}, now })
    ).toEqual(['rt-1', 'rt-2'])
  })

  it('reclaims a quiet terminal even while its session is in use', () => {
    expect(
      reclaimableRightTermIds({
        terms,
        lastUsedAt: now - hour,
        activityAt: { 'rt-1': now - 9 * hour, 'rt-2': now - 2 * hour },
        now
      })
    ).toEqual(['rt-1'])
  })

  it('keeps a terminal it has no activity record for', () => {
    expect(reclaimableRightTermIds({ terms, lastUsedAt: now - hour, activityAt: {}, now })).toEqual(
      []
    )
  })

  it('keeps a terminal running a foreground process, however long it has been quiet', () => {
    expect(
      reclaimableRightTermIds({
        terms,
        lastUsedAt: now - 20 * hour,
        activityAt: {},
        states: { 'rt-1': { running: true, processRunning: true } },
        now
      })
    ).toEqual(['rt-2'])
  })

  it('counts output notification as activity', () => {
    expect(
      reclaimableRightTermIds({
        terms,
        lastUsedAt: now - hour,
        activityAt: {},
        states: { 'rt-1': { unread: true, lastEventAt: now - hour } },
        now
      })
    ).toEqual([])
  })

  it('keeps everything younger than the retention window', () => {
    expect(
      reclaimableRightTermIds({
        terms,
        lastUsedAt: now - 7 * hour,
        activityAt: { 'rt-1': now - 7 * hour, 'rt-2': now },
        now
      })
    ).toEqual([])
  })
})
