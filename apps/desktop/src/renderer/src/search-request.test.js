import { describe, expect, it } from 'vitest'
import { createSearchRequestId } from './search-request'

describe('search request identifiers', () => {
  it('creates distinct serializable identifiers for independent callers', () => {
    const ids = Array.from({ length: 1000 }, () => createSearchRequestId())
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => /^[0-9a-f]{32}$/.test(id))).toBe(true)
  })
})
