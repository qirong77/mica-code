import { describe, expect, it } from 'bun:test'
import { createTerminalResync } from './terminal-resync'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

function setup(snapshot) {
  const calls = []
  let current = true
  const sync = createTerminalResync({
    snapshot,
    reset: (tail) => calls.push(['reset', tail]),
    data: ({ data }) => calls.push(['data', data]),
    exit: (event) => calls.push(['exit', !!event.missing]),
    isCurrent: () => current
  })
  return { sync, calls, unmount: () => { current = false } }
}

describe('terminal resynchronization', () => {
  it('buffers events until the terminal has finished resetting', async () => {
    const reset = deferred()
    const calls = []
    const sync = createTerminalResync({
      snapshot: async () => ({ exists: true, replay: 'tail', seq: 1 }),
      reset: () => reset.promise,
      data: ({ data }) => calls.push(data),
      exit: () => {},
      isCurrent: () => true
    })
    const pending = sync.resync()
    await Promise.resolve()
    sync.receive({ type: 'data', seq: 2, data: 'after' })
    expect(calls).toEqual([])
    reset.resolve()
    await pending
    expect(calls).toEqual(['after'])
  })

  it('replays the snapshot and only events after its sequence, including exit', async () => {
    const request = deferred()
    const { sync, calls } = setup(() => request.promise)
    const pending = sync.resync()
    sync.receive({ type: 'data', seq: 2, data: 'already in tail' })
    sync.receive({ type: 'data', seq: 4, data: 'new' })
    sync.receive({ type: 'exit', seq: 5 })
    request.resolve({ exists: true, replay: 'tail', seq: 3 })
    await pending
    sync.receive({ type: 'data', seq: 4, data: 'duplicate' })
    expect(calls).toEqual([['reset', 'tail'], ['data', 'new'], ['exit', false]])
  })

  it('retains missing state without resetting and processes later events', async () => {
    const request = deferred()
    const { sync, calls } = setup(() => request.promise)
    const pending = sync.resync()
    sync.receive({ type: 'exit', seq: 8 })
    sync.receive({ type: 'data', seq: 10, data: 'new PTY' })
    request.resolve({ exists: false, seq: 9 })
    await pending
    expect(calls).toEqual([['exit', true], ['data', 'new PTY']])
  })

  it('serializes overlapping requests and refreshes again', async () => {
    const first = deferred()
    const second = deferred()
    let count = 0
    const { sync, calls } = setup(() => (++count === 1 ? first.promise : second.promise))
    const pending = sync.resync()
    sync.resync()
    first.resolve({ exists: true, replay: 'first', seq: 1 })
    await Promise.resolve()
    await Promise.resolve()
    sync.receive({ type: 'data', seq: 3, data: 'after second snapshot' })
    second.resolve({ exists: true, replay: 'second', seq: 2 })
    await pending
    expect(count).toBe(2)
    expect(calls).toEqual([['reset', 'first'], ['reset', 'second'], ['data', 'after second snapshot']])
  })

  it('flushes buffered events on failure and ignores results after unmount', async () => {
    const first = deferred()
    const { sync, calls, unmount } = setup(() => first.promise)
    const pending = sync.resync()
    sync.receive({ type: 'data', seq: 1, data: 'live' })
    first.reject(new Error('offline'))
    await expect(pending).rejects.toThrow('offline')
    expect(calls).toEqual([['data', 'live']])
    const second = deferred()
    const other = setup(() => second.promise)
    const abandoned = other.sync.resync()
    other.unmount()
    second.resolve({ exists: true, replay: 'stale', seq: 1 })
    await abandoned
    expect(other.calls).toEqual([])
    unmount()
  })
})
