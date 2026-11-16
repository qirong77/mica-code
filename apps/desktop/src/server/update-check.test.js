import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { createUpdateChecker } from './update-check.js'

const commit = (char) => char.repeat(40)

test('reports a newer main commit and coalesces concurrent checks', async () => {
  let calls = 0
  let resolve
  const fetchImpl = async () => {
    calls += 1
    await new Promise((done) => {
      resolve = done
    })
    return {
      ok: true,
      async json() {
        return { sha: commit('b'), commit: { message: 'new feature\nbody' } }
      }
    }
  }
  const checker = createUpdateChecker({ currentCommit: commit('a'), fetchImpl })
  const first = checker.check({ force: true })
  const second = checker.check({ force: true })
  assert.equal(calls, 1)
  resolve()
  const result = await first
  assert.deepEqual(await second, result)
  assert.equal(result.available, true)
  assert.equal(result.latestShortCommit, commit('b').slice(0, 7))
  assert.equal(result.latestMessage, 'new feature')
})

test('uses the TTL cache and does not report an update when commits match', async () => {
  let calls = 0
  const checker = createUpdateChecker({
    currentCommit: commit('a'),
    fetchImpl: async () => {
      calls += 1
      return {
        ok: true,
        async json() {
          return { sha: commit('a') }
        }
      }
    },
    now: () => 1000,
    ttlMs: 10_000
  })
  const first = await checker.check()
  const second = await checker.check()
  assert.equal(calls, 1)
  assert.equal(first.available, false)
  assert.deepEqual(second, first)
})

test('keeps a previously discovered update when the next network check fails', async () => {
  let calls = 0
  const checker = createUpdateChecker({
    currentCommit: commit('a'),
    ttlMs: 0,
    fetchImpl: async () => {
      calls += 1
      if (calls === 1)
        return {
          ok: true,
          async json() {
            return { sha: commit('b') }
          }
        }
      throw new Error('offline')
    }
  })
  const first = await checker.check({ force: true })
  const second = await checker.check({ force: true })
  assert.equal(first.available, true)
  assert.equal(second.available, true)
  assert.equal(second.stale, true)
  assert.match(second.error, /offline/)
})
