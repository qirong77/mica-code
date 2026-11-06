import { describe, expect, it } from 'vitest'
import { createPanelViewCache } from './chat-panel-cache.js'

describe('panel view cache', () => {
  it('coalesces a slow request for its entire lifetime and starts TTL on completion', async () => {
    let at = 0
    let calls = 0
    let finish
    const cache = createPanelViewCache({ now: () => at })
    const load = () => {
      calls++
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    const first = cache.read('panel', load)
    await Promise.resolve()
    at = 60_000
    expect(cache.read('panel', load)).toBe(first)
    expect(calls).toBe(1)
    finish({ ok: true, view: { label: 'done' } })
    await first
    at += 2999
    expect(cache.read('panel', load)).toBe(first)
    at++
    expect(cache.read('panel', () => ({ ok: true }))).not.toBe(first)
  })

  it('does not cache failed results or thrown failures', async () => {
    const cache = createPanelViewCache()
    await cache.read('panel', () => ({ ok: false }))
    expect(await cache.read('panel', () => ({ ok: true }))).toEqual({ ok: true })
    await expect(
      cache.read('error', () => {
        throw new Error('failed')
      })
    ).rejects.toThrow('failed')
    expect(await cache.read('error', () => ({ ok: true }))).toEqual({ ok: true })
  })

  it('does not restore an invalidated result after an action', async () => {
    const cache = createPanelViewCache()
    let finish
    const stale = cache.read(
      'panel',
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await Promise.resolve()
    cache.clear()
    const fresh = cache.read('panel', () => ({ ok: true, version: 2 }))
    await fresh
    finish({ ok: true, version: 1 })
    await stale
    expect(cache.read('panel', () => ({ version: 3 }))).toBe(fresh)
  })

  it('bounds queued queries while preserving in-flight deduplication', async () => {
    const cache = createPanelViewCache({ maxEntries: 1 })
    let finish
    const pending = cache.read(
      'a',
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await Promise.resolve()
    expect(
      (
        await cache.read('b', () => {
          throw new Error('must not run')
        })
      ).ok
    ).toBe(false)
    expect(
      cache.read('a', () => {
        throw new Error('duplicate')
      })
    ).toBe(pending)
    finish({ ok: true })
    await pending
    expect(await cache.read('b', () => ({ ok: true }))).toEqual({ ok: true })
  })
})
