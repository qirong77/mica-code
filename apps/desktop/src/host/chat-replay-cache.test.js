import { describe, expect, it } from 'vitest'
import { createCompletedRunCache } from './chat-replay-cache.js'

describe('completed run memory budget', () => {
  it('evicts old replays by text size as well as run count', () => {
    const cache = createCompletedRunCache({ maxRuns: 3, maxChars: 100 })
    cache.set('a', { text: 'a'.repeat(50) })
    cache.set('b', { text: 'b'.repeat(50) })
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b').text).toHaveLength(50)
    cache.set('huge', { text: 'x'.repeat(101) })
    expect(cache.get('huge')).toBeUndefined()
    expect(cache.get('b')).toBeDefined()
  })

  it('releases accounting on replacement, deletion and clear', () => {
    const cache = createCompletedRunCache({ maxRuns: 2, maxChars: 100 })
    cache.set('a', { text: 'x'.repeat(70) })
    cache.set('a', { text: 'small' })
    cache.set('b', { text: 'x'.repeat(70) })
    expect(cache.get('a')).toBeDefined()
    cache.delete('b')
    cache.set('c', { text: 'x'.repeat(70) })
    expect(cache.get('a')).toBeDefined()
    cache.clear()
    cache.set('d', { text: 'x'.repeat(70) })
    expect(cache.get('d')).toBeDefined()
    expect(cache.get('a')).toBeUndefined()
  })

  it('retains the newest runs when the count budget is reached', () => {
    const cache = createCompletedRunCache({ maxRuns: 2 })
    for (const key of ['a', 'b', 'c']) cache.set(key, { text: key })
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeDefined()
    expect(cache.get('c')).toBeDefined()
  })
})
