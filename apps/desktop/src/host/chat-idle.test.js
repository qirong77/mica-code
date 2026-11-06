import { describe, expect, it } from 'vitest'
import {
  IDLE_MAX_KEEP,
  IDLE_REAP_MS,
  isHostActivityRequest,
  noteHostMessageActivity,
  resolveIdleReap
} from './chat-idle'

const NOW = 1_000_000_000

function host(lastActivityAt, extra = {}) {
  return { child: { stdin: { writable: true } }, lastActivityAt, ...extra }
}

function dead(lastActivityAt) {
  return { child: { stdin: { writable: false } }, lastActivityAt }
}

function entry(id, run, queuedCount = 0) {
  return { id, run, queuedCount }
}

describe('resolveIdleReap', () => {
  it('does not keep idle hosts alive through view polls or periodic task snapshots', () => {
    const run = host(NOW - IDLE_REAP_MS * 2, {
      pendingRequests: new Map([[1, { method: 'mica/pluginPanel/view' }]])
    })
    noteHostMessageActivity(run, { id: 1, result: {} }, NOW)
    run.pendingRequests.delete(1)
    noteHostMessageActivity(
      run,
      { method: 'mica/subagentTasks/updated', params: { tasks: [] } },
      NOW
    )
    expect(run.lastActivityAt).toBe(NOW - IDLE_REAP_MS * 2)
    expect(resolveIdleReap([entry('current', host(NOW)), entry('old', run)], NOW)).toEqual(['old'])
    noteHostMessageActivity(run, { method: 'turn/completed' }, NOW)
    expect(run.lastActivityAt).toBe(NOW)
    expect(isHostActivityRequest('mica/pluginPanel/action')).toBe(true)
    expect(isHostActivityRequest('mica/subagentTasks/detail')).toBe(false)
  })

  it('does not recycle a host while an awaited query or action is in flight', () => {
    const run = host(NOW - IDLE_REAP_MS * 2, {
      pendingRequests: new Map([[1, { method: 'mica/pluginPanel/action' }]])
    })
    expect(resolveIdleReap([entry('current', host(NOW)), entry('old', run)], NOW)).toEqual([])
  })

  it('keeps the only host alive even when it has been idle for a day', () => {
    // 手机桥、定时循环只活在会话宿主里：全收干净它们就凭空停摆。
    expect(resolveIdleReap([entry('a', host(NOW - IDLE_REAP_MS * 48))], NOW)).toEqual([])
  })

  it('keeps the most recently active host and reaps the stale ones', () => {
    const entries = [
      entry('old', host(NOW - IDLE_REAP_MS * 3)),
      entry('new', host(NOW - 60_000)),
      entry('mid', host(NOW - IDLE_REAP_MS * 2))
    ]
    expect(resolveIdleReap(entries, NOW).sort()).toEqual(['mid', 'old'])
  })

  it('reaps hosts beyond the hard cap even when they are active', () => {
    // 5 个都刚用过（还没进闲置期）：仍然只留 3 个，进程数量本身就是代价。
    const entries = [
      entry('a', host(NOW - 1000)),
      entry('b', host(NOW - 2000)),
      entry('c', host(NOW - 3000)),
      entry('d', host(NOW - 4000)),
      entry('e', host(NOW - 5000))
    ]
    expect(resolveIdleReap(entries, NOW, { maxKeep: IDLE_MAX_KEEP }).sort()).toEqual(['d', 'e'])
  })

  it('still skips busy hosts beyond the cap', () => {
    const entries = [
      entry('a', host(NOW - 1000)),
      entry('b', host(NOW - 2000)),
      entry('c', host(NOW - 3000)),
      entry('d', host(NOW - 4000, { running: true })),
      entry('e', host(NOW - 5000))
    ]
    expect(resolveIdleReap(entries, NOW, { maxKeep: IDLE_MAX_KEEP })).toEqual(['e'])
  })

  it('does not reap a host that is still inside the idle window', () => {
    const entries = [entry('a', host(NOW - 60_000)), entry('b', host(NOW - 120_000))]
    expect(resolveIdleReap(entries, NOW)).toEqual([])
  })

  it('never reaps a host with a turn, compaction or abort in flight', () => {
    const stale = NOW - IDLE_REAP_MS * 5
    const entries = [
      entry('keep', host(NOW)),
      entry('turning', host(stale, { running: true })),
      entry(
        'maintaining',
        host(stale, { maintenance: { reason: 'compaction', label: '自动压缩' } })
      ),
      entry('aborting', host(stale, { aborting: true })),
      entry('turn-id', host(stale, { currentTurnId: 't-1' }))
    ]
    expect(resolveIdleReap(entries, NOW)).toEqual([])
  })

  it('never reaps a host that still has queued input or a btw thread', () => {
    const stale = NOW - IDLE_REAP_MS * 5
    const entries = [
      entry('keep', host(NOW)),
      entry('host-pending', host(stale, { hostPending: [{ prompt: 'hi' }] })),
      entry('btw', host(stale, { btwBusyThreads: new Set(['t1']) }))
    ]
    expect(resolveIdleReap(entries, NOW)).toEqual([])
  })

  it('never reaps a host with local queued messages', () => {
    const stale = NOW - IDLE_REAP_MS * 5
    const entries = [entry('keep', host(NOW)), entry('queued', host(stale), 1)]
    expect(resolveIdleReap(entries, NOW)).toEqual([])
  })

  it('ignores hosts whose process is already gone', () => {
    const entries = [entry('alive', host(NOW)), entry('gone', dead(NOW - IDLE_REAP_MS * 9))]
    expect(resolveIdleReap(entries, NOW)).toEqual([])
  })

  it('honours a caller-supplied idle window', () => {
    const entries = [entry('keep', host(NOW)), entry('stale', host(NOW - 5000))]
    expect(resolveIdleReap(entries, NOW, { idleMs: 1000 })).toEqual(['stale'])
  })

  it('treats a host with no activity timestamp as the oldest', () => {
    const entries = [entry('keep', host(NOW)), entry('unknown', host(undefined))]
    expect(resolveIdleReap(entries, NOW)).toEqual(['unknown'])
  })
})
