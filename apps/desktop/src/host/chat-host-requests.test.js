import { describe, expect, it } from 'vitest'
import { settlePendingHostRequests } from './chat-host-requests.js'

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
