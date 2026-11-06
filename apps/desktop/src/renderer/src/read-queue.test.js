import { describe, expect, test } from 'bun:test'
import { createReadQueue } from './read-queue.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('createReadQueue', () => {
  test('slow polling shares one request without scheduling a backlog', async () => {
    const pending = deferred()
    let reads = 0
    const queue = createReadQueue(async () => {
      reads += 1
      await pending.promise
    })
    const first = queue.refresh()
    await Promise.resolve()
    for (let index = 0; index < 20; index += 1) expect(queue.refresh()).toBe(first)
    expect(reads).toBe(1)
    pending.resolve()
    await first
    expect(reads).toBe(1)
    await queue.refresh()
    expect(reads).toBe(2)
  })

  test('a burst of changes during a read gets one fresh follow-up with no overlap', async () => {
    const pending = deferred()
    let reads = 0
    let active = 0
    const queue = createReadQueue(async () => {
      expect(++active).toBe(1)
      reads += 1
      if (reads === 1) await pending.promise
      active -= 1
    })
    const first = queue.refresh()
    await Promise.resolve()
    for (let index = 0; index < 20; index += 1) queue.refresh({ trailing: true })
    pending.resolve()
    await first
    expect(reads).toBe(2)
    expect(active).toBe(0)
  })

  test('hidden/unfocused views skip reads and queued work; returning can refresh immediately', async () => {
    const pending = deferred()
    let visible = false
    let reads = 0
    const queue = createReadQueue(
      async () => {
        reads += 1
        await pending.promise
      },
      {
        canRead: () => visible
      }
    )
    await queue.refresh()
    expect(reads).toBe(0)
    visible = true
    const first = queue.refresh()
    await Promise.resolve()
    queue.refresh({ trailing: true })
    visible = false
    pending.resolve()
    await first
    expect(reads).toBe(1)
    visible = true
    await queue.refresh()
    expect(reads).toBe(2)
  })

  test('local actions invalidate old results while keeping the outstanding request serialized', async () => {
    const pending = deferred()
    const applied = []
    let reads = 0
    const queue = createReadQueue(async (isCurrent) => {
      const result = ++reads
      if (result === 1) await pending.promise
      if (isCurrent()) applied.push(result)
    })
    const first = queue.refresh()
    await Promise.resolve()
    queue.invalidate()
    queue.refresh({ trailing: true })
    pending.resolve()
    await first
    expect(applied).toEqual([2])
  })

  test('disposal drops outstanding results and queued reads', async () => {
    const pending = deferred()
    let reads = 0
    let applied = false
    const queue = createReadQueue(async (isCurrent) => {
      reads += 1
      await pending.promise
      applied = isCurrent()
    })
    const first = queue.refresh()
    await Promise.resolve()
    queue.refresh({ trailing: true })
    queue.dispose()
    pending.resolve()
    await first
    await queue.refresh()
    expect(reads).toBe(1)
    expect(applied).toBe(false)
  })

  test('a failed read releases the queue and reports the error once', async () => {
    const errors = []
    let reads = 0
    const queue = createReadQueue(
      async () => {
        if (++reads === 1) throw new Error('offline')
      },
      { onError: (error) => errors.push(error.message) }
    )
    await queue.refresh()
    await queue.refresh()
    expect(errors).toEqual(['offline'])
    expect(reads).toBe(2)
  })
})
