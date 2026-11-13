import { describe, expect, test } from 'bun:test'
import { createChatResyncQueue } from './chat-resync.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function timers() {
  const scheduled = new Map()
  let nextId = 0
  return {
    scheduled,
    schedule(callback, delay) {
      const id = ++nextId
      scheduled.set(id, { callback, delay })
      return id
    },
    cancel(id) { scheduled.delete(id) },
    fire() {
      const [id, timer] = scheduled.entries().next().value
      scheduled.delete(id)
      timer.callback()
    }
  }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('chat resync queue', () => {
  test('serializes restores and coalesces gaps that arrive during a restore', async () => {
    const first = deferred()
    const second = deferred()
    let calls = 0
    const queue = createChatResyncQueue(() => {
      calls += 1
      return calls === 1 ? first.promise : second.promise
    })
    queue.request()
    queue.request()
    queue.request()
    expect(calls).toBe(1)
    first.resolve()
    await first.promise
    await Promise.resolve()
    expect(calls).toBe(2)
    second.resolve()
    await second.promise
  })

  test('disposal drops pending requests when switching sessions', async () => {
    const first = deferred()
    let calls = 0
    const queue = createChatResyncQueue(() => { calls += 1; return first.promise })
    queue.request()
    queue.request()
    queue.dispose()
    first.resolve()
    await first.promise
    await Promise.resolve()
    queue.request()
    expect(calls).toBe(1)
  })

  test('retries a failed restore and merges pending and later requests', async () => {
    const first = deferred()
    const errors = []
    const clock = timers()
    let calls = 0
    const queue = createChatResyncQueue(async () => {
      calls += 1
      if (calls === 1) {
        await first.promise
        throw new Error('offline')
      }
    }, (error) => errors.push(error.message), { ...clock, retryDelays: [10, 20] })
    queue.request()
    queue.request()
    first.resolve()
    await first.promise
    await settle()
    expect(errors).toEqual(['offline'])
    expect(calls).toBe(1)
    queue.request()
    queue.request()
    expect([...clock.scheduled.values()].map((timer) => timer.delay)).toEqual([10])
    clock.fire()
    await settle()
    expect(calls).toBe(2)
    expect(clock.scheduled.size).toBe(0)
    queue.dispose()
  })

  test('bounds retries and allows a later request to start a new cycle', async () => {
    const clock = timers()
    let calls = 0
    const queue = createChatResyncQueue(async () => {
      calls += 1
      throw new Error('offline')
    }, () => {}, { ...clock, retryDelays: [10, 20] })
    queue.request()
    await settle()
    expect([...clock.scheduled.values()][0].delay).toBe(10)
    clock.fire()
    await settle()
    expect([...clock.scheduled.values()][0].delay).toBe(20)
    clock.fire()
    await settle()
    expect(calls).toBe(3)
    expect(clock.scheduled.size).toBe(0)
    queue.request()
    await settle()
    expect(calls).toBe(4)
    expect([...clock.scheduled.values()][0].delay).toBe(10)
    queue.dispose()
    expect(clock.scheduled.size).toBe(0)
  })

  test('disposal during a failed restore does not schedule a retry or report an error', async () => {
    const first = deferred()
    const clock = timers()
    const errors = []
    const queue = createChatResyncQueue(async () => {
      await first.promise
      throw new Error('offline')
    }, (error) => errors.push(error), { ...clock, retryDelays: [10] })
    queue.request()
    queue.dispose()
    first.resolve()
    await settle()
    expect(errors).toEqual([])
    expect(clock.scheduled.size).toBe(0)
  })

  test('a request during the last failed attempt is retained', async () => {
    const clock = timers()
    const last = deferred()
    let calls = 0
    const queue = createChatResyncQueue(async () => {
      calls += 1
      if (calls === 2) await last.promise
      if (calls < 3) throw new Error('offline')
    }, () => {}, { ...clock, retryDelays: [10] })
    queue.request()
    await settle()
    clock.fire()
    queue.request()
    last.resolve()
    await settle()
    expect(clock.scheduled.size).toBe(1)
    clock.fire()
    await settle()
    expect(calls).toBe(3)
    queue.dispose()
  })
})
