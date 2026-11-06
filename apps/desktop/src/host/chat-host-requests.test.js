import { describe, expect, it } from 'vitest'
import { requestHostTask, settlePendingHostRequests } from './chat-host-requests.js'

function makeRun(pendingEntries) {
  return { pendingRequests: new Map(pendingEntries) }
}

describe('settlePendingHostRequests', () => {
  it('rejects the turn that was never acknowledged and reports it for rollback', () => {
    const run = makeRun([
      [
        1,
        {
          method: 'turn/start',
          params: { clientMessageId: 'optimistic-1', input: [{ type: 'text', text: '你好' }] }
        }
      ]
    ])

    const { rejectedTurns } = settlePendingHostRequests(
      run,
      'Model x exposes no reasoning effort levels'
    )

    expect(rejectedTurns).toEqual([
      { method: 'turn/start', clientMessageId: 'optimistic-1', text: '你好' }
    ])
    // 结算过的请求不能留在表里：同一个 Map 还会被后续 close/error 处理复用。
    expect(run.pendingRequests.size).toBe(0)
  })

  it('settles IPC round-trips through their resolve instead of turning them into rollbacks', () => {
    const results = []
    const run = makeRun([
      [7, { method: 'mica/turn/editMessage', params: {}, resolve: (value) => results.push(value) }]
    ])

    const { rejectedTurns } = settlePendingHostRequests(run, '进程已退出')

    expect(results).toEqual([{ ok: false, error: '进程已退出' }])
    expect(rejectedTurns).toEqual([])
  })

  it('ignores requests that are neither turns nor awaited, and tolerates a missing map', () => {
    const run = makeRun([
      [
        3,
        {
          method: 'turn/steer',
          params: { clientMessageId: 'q1', input: [{ type: 'text', text: '排队' }] }
        }
      ],
      [4, { method: 'mica/backgroundTask/output', params: {} }],
      [5, null]
    ])

    expect(settlePendingHostRequests(run, 'boom').rejectedTurns).toEqual([
      { method: 'turn/steer', clientMessageId: 'q1', text: '排队' }
    ])
    expect(settlePendingHostRequests({}, 'boom').rejectedTurns).toEqual([])
    expect(settlePendingHostRequests(undefined, 'boom').rejectedTurns).toEqual([])
  })
})

describe('requestHostTask', () => {
  function pendingRun() {
    return { child: { stdin: { writable: true } }, requestSeq: 0, pendingRequests: new Map() }
  }
  const send = (run, method, params, options) => {
    run.pendingRequests.set(++run.requestSeq, { method, params, ...options })
    return true
  }

  it('releases timed-out entries and their retained parameters', async () => {
    const run = pendingRun()
    const result = await requestHostTask(
      run,
      'mica/pluginPanel/view',
      { pluginId: 'test' },
      { timeoutMs: 1, send }
    )
    expect(result.ok).toBe(false)
    expect(run.pendingRequests.size).toBe(0)
  })

  it('settles on shutdown and ignores a late reply', async () => {
    const run = pendingRun()
    const result = requestHostTask(run, 'query', {}, { timeoutMs: 10_000, send })
    const pending = run.pendingRequests.get(run.requestSeq)
    settlePendingHostRequests(run, 'closed')
    pending.resolve({ ok: true })
    expect(await result).toEqual({ ok: false, error: 'closed' })
    expect(run.pendingRequests.size).toBe(0)
  })

  it('cleans up after a synchronous write failure', async () => {
    const run = pendingRun()
    const result = await requestHostTask(
      run,
      'query',
      {},
      {
        timeoutMs: 10_000,
        send: (...args) => {
          send(...args)
          throw new Error('EPIPE')
        }
      }
    )
    expect(result.ok).toBe(false)
    expect(run.pendingRequests.size).toBe(0)
  })
})
