import { describe, expect, it } from 'bun:test'
import { createSessionListVersions } from './session-list-versions.js'
import { applySessionListUpdate } from '../renderer/src/session-list-update.js'

const row = (id, extra = {}) => ({
  id,
  title: `会话 ${id}`,
  cwd: '/project',
  updatedAtMs: 1,
  ...extra
})

describe('session index versions', () => {
  it('sends a full initial index and no data for an unchanged version', () => {
    const list = createSessionListVersions()
    const rows = [row('a'), row('b')]
    const first = list(rows, { delta: true })
    expect(first.delta).toBe(false)
    expect(first.sessions).toBe(rows)
    expect(list(rows, { since: first.etag, delta: true })).toEqual({
      sessions: [],
      etag: first.etag,
      unchanged: true
    })
  })

  it('transfers only the changed record while preserving unchanged client row references', () => {
    const list = createSessionListVersions()
    const rows = Array.from({ length: 1000 }, (_, index) => row(String(index)))
    const first = list(rows)
    const nextRows = [
      row('500', { updatedAtMs: 2, awaiting: true }),
      ...rows.filter((r) => r.id !== '500')
    ]
    const update = list(nextRows, { since: first.etag, delta: true })
    expect(update.delta).toBe(true)
    expect(update.sessions).toHaveLength(1)
    expect(update.removed).toEqual([])
    const merged = applySessionListUpdate(rows, update, first.etag)
    expect(merged).toEqual(nextRows)
    expect(merged[1]).toBe(rows[0])
    expect(Buffer.byteLength(JSON.stringify(update))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(nextRows)) / 5
    )
  })

  it('handles additions, deletions, sorting and nested metadata across skipped versions', () => {
    const list = createSessionListVersions()
    const rows = [row('a'), row('b'), row('c'), row('d'), row('e')]
    const first = list(rows)
    list([row('c', { metadata: { running: true } }), ...rows.filter((r) => r.id !== 'c')])
    const expected = [row('f'), rows[3], rows[1], rows[0], rows[4]]
    const update = list(expected, { delta: true, since: first.etag })
    expect(update.delta).toBe(true)
    expect(update.removed).toEqual(['c'])
    expect(applySessionListUpdate(rows, update, first.etag)).toEqual(expected)
    const empty = list([], { delta: true, since: update.etag })
    expect(applySessionListUpdate(expected, empty, update.etag)).toEqual([])
  })

  it('sends the complete current index when the baseline expired or the runtime restarted', () => {
    const list = createSessionListVersions({ maxVersions: 2, generation: 'old' })
    const first = list([row('a')])
    list([row('b')])
    const current = [row('c')]
    const expired = list(current, { since: first.etag, delta: true })
    expect(expired.delta).toBe(false)
    expect(expired.sessions).toBe(current)
    const restarted = createSessionListVersions({ generation: 'new' })(current, {
      since: expired.etag,
      delta: true
    })
    expect(restarted.delta).toBe(false)
    expect(restarted.etag).not.toBe(expired.etag)
  })

  it('keeps callers that need a complete index explicit, and avoids large patches', () => {
    const list = createSessionListVersions()
    const first = list([row('a'), row('b'), row('c')])
    const rows = [row('a', { title: 'renamed' }), row('b'), row('c')]
    expect(list(rows, { since: first.etag }).sessions).toBe(rows)
    const replaced = [row('x'), row('y'), row('z')]
    expect(list(replaced, { since: first.etag, delta: true }).delta).toBe(false)
  })

  it('rejects a mismatched or incomplete delta instead of erasing other sessions', () => {
    const previous = [row('a'), row('b')]
    const patch = { delta: true, baseEtag: '1', sessions: [], removed: [], order: ['b', 'a'] }
    expect(applySessionListUpdate(previous, patch, 'wrong')).toBeNull()
    expect(applySessionListUpdate(previous, { ...patch, order: ['a'] }, '1')).toBeNull()
    expect(applySessionListUpdate(previous, { ...patch, order: ['a', 'a'] }, '1')).toBeNull()
    expect(applySessionListUpdate(previous, { ...patch, order: ['a', 'unknown'] }, '1')).toBeNull()
    expect(applySessionListUpdate(previous, { unchanged: true }, '1')).toBe(previous)
  })
})
