import { describe, expect, it } from 'bun:test'
import {
  findRunByOwnerId,
  findRunForSession,
  liveViewerIds,
  ownerIdOf,
  planRunRelease,
  pruneViewers,
  shouldReapTransferredRun,
  touchViewer,
  TRANSFERRED_REAP_GRACE_MS,
  VIEWER_TTL_MS
} from './chat-viewers'

function runFixture(overrides = {}) {
  return {
    sessionId: null,
    requestedSessionId: null,
    running: false,
    viewers: new Map(),
    ...overrides
  }
}

function runsFixture(entries) {
  return new Map(entries.map(([id, overrides]) => [id, runFixture(overrides)]))
}

describe('findRunForSession', () => {
  it('attaches to the running run of the session instead of an idle one', () => {
    const runs = runsFixture([
      ['term-a', { sessionId: 's1', running: false }],
      ['term-b', { sessionId: 's1', running: true }]
    ])
    expect(findRunForSession(runs, 's1', 'term-c').id).toBe('term-b')
  })

  it('matches a run that has not been bound to a session id yet', () => {
    const runs = runsFixture([['term-a', { sessionId: null, requestedSessionId: 's1' }]])
    expect(findRunForSession(runs, 's1', 'term-b').id).toBe('term-a')
  })

  it('never returns the asking node own run and ignores unrelated sessions', () => {
    const runs = runsFixture([
      ['term-a', { sessionId: 's1', running: true }],
      ['term-b', { sessionId: 's2', running: true }]
    ])
    expect(findRunForSession(runs, 's1', 'term-a')).toBeNull()
    expect(findRunForSession(runs, 's3', 'term-a')).toBeNull()
    expect(findRunForSession(runs, null, 'term-a')).toBeNull()
  })
})

describe('viewers', () => {
  it('keeps the owner out of its own viewer list', () => {
    const run = runFixture()
    touchViewer(run, 'term-a', 'term-a', 1000)
    expect(run.viewers.size).toBe(0)
    touchViewer(run, 'term-a', 'term-b', 1000)
    expect(liveViewerIds(run, { now: 1000 })).toEqual(['term-b'])
  })

  it('expires a viewer that stopped checking in', () => {
    const run = runFixture()
    touchViewer(run, 'term-a', 'term-b', 1000)
    expect(liveViewerIds(run, { now: 1000 + VIEWER_TTL_MS })).toEqual(['term-b'])
    expect(liveViewerIds(run, { now: 1000 + VIEWER_TTL_MS + 1 })).toEqual([])
    expect(pruneViewers(run, { now: 1000 + VIEWER_TTL_MS + 1 })).toEqual([])
    expect(run.viewers.size).toBe(0)
  })

  it('finds a run whose ownership was transferred to this node', () => {
    const runs = runsFixture([['term-a', { sessionId: 's1', ownerId: 'term-b' }]])
    expect(ownerIdOf('term-a', runs.get('term-a'))).toBe('term-b')
    expect(findRunByOwnerId(runs, 'term-b').id).toBe('term-a')
    expect(findRunByOwnerId(runs, 'term-a')).toBeNull()
  })
})

describe('planRunRelease', () => {
  it('only detaches an observer', () => {
    const viewers = new Map([['term-b', 2000]])
    expect(
      planRunRelease({ keyId: 'term-a', nodeId: 'term-b', ownerId: 'term-a', viewers })
    ).toEqual({
      action: 'detach',
      keyId: 'term-a'
    })
  })

  it('disposes when the owner leaves and nobody is watching', () => {
    expect(planRunRelease({ keyId: 'term-a', nodeId: 'term-a', viewers: new Map() })).toEqual({
      action: 'dispose',
      keyId: 'term-a'
    })
    // 观察者已经超时：等同没人看
    const viewers = new Map([['term-b', 1000]])
    expect(
      planRunRelease({ keyId: 'term-a', nodeId: 'term-a', viewers, now: 1000 + VIEWER_TTL_MS + 1 })
    ).toEqual({ action: 'dispose', keyId: 'term-a' })
  })

  it('hands the run to the most recent live viewer', () => {
    const viewers = new Map([
      ['term-b', 3000],
      ['term-c', 5000]
    ])
    expect(planRunRelease({ keyId: 'term-a', nodeId: 'term-a', viewers, now: 5000 })).toEqual({
      action: 'transfer',
      keyId: 'term-a',
      nextOwnerId: 'term-c'
    })
  })

  it('lets the transferred owner release the run it took over', () => {
    const viewers = new Map()
    expect(
      planRunRelease({ keyId: 'term-a', nodeId: 'term-b', ownerId: 'term-b', viewers })
    ).toEqual({ action: 'dispose', keyId: 'term-a' })
  })
})

describe('shouldReapTransferredRun', () => {
  it('never reaps a run nobody took over', () => {
    expect(shouldReapTransferredRun(runFixture())).toBe(false)
  })

  it('keeps the run alive while a viewer is still checking in', () => {
    const run = runFixture({ ownerTransferredAt: 1000, viewers: new Map([['term-b', 2000]]) })
    expect(shouldReapTransferredRun(run, { now: 2000 })).toBe(false)
  })

  it('reaps an idle transferred run once every viewer timed out', () => {
    const run = runFixture({ ownerTransferredAt: 1000, viewers: new Map([['term-b', 2000]]) })
    expect(shouldReapTransferredRun(run, { now: 2000 + VIEWER_TTL_MS + 1 })).toBe(true)
  })

  it('gives an in-flight turn its grace period before reaping', () => {
    const run = runFixture({ ownerTransferredAt: 1000, running: true })
    expect(shouldReapTransferredRun(run, { now: 60_000 })).toBe(false)
    expect(shouldReapTransferredRun(run, { now: 1000 + TRANSFERRED_REAP_GRACE_MS })).toBe(true)
  })
})
