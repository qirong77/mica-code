import { describe, expect, test } from 'bun:test'
import {
  closeReviewTab,
  isFileReviewed,
  openReviewTabs,
  reconcileReviewTabs,
  reviewScope,
  updateReviewed
} from './git-review'

describe('comparison review state', () => {
  test('single clicks reuse a preview while pinned and batch tabs remain', () => {
    const base = { mode: 'snapshot', ref: 'hash' }
    let state = { tabs: [], active: null }
    state = openReviewTabs(state, { path: 'a' }, base)
    state = openReviewTabs(state, { path: 'b' }, base)
    expect(state.tabs.map((tab) => tab.path)).toEqual(['b'])
    state = openReviewTabs(state, { path: 'b' }, base, true)
    state = openReviewTabs(state, { path: 'c' }, base)
    state = openReviewTabs(state, { path: 'd' }, base)
    expect(state.tabs.map((tab) => tab.path)).toEqual(['b', 'd'])
    expect(state.tabs[0].preview).toBe(false)
    state = openReviewTabs(state, [{ path: 'b' }, { path: 'd' }, { path: 'e' }], base)
    expect(state.tabs.map((tab) => tab.path)).toEqual(['b', 'd', 'e'])
    expect(state.tabs.every((tab) => !tab.preview)).toBe(true)
  })
  test('keeps repositories, bases and compare modes separate', () => {
    const a = reviewScope('/a', { ref: 'main' })
    expect(a).not.toBe(reviewScope('/b', { ref: 'main' }))
    expect(a).not.toBe(reviewScope('/a', { ref: 'other' }))
    expect(a).not.toBe(reviewScope('/a', { ref: 'main', direct: true }))
  })
  test('content changes invalidate reviewed state even if line counts stay the same', () => {
    const file = { path: 'a.js', fingerprint: 'before' }
    const reviewed = updateReviewed({}, [file], true)
    expect(isFileReviewed(file, reviewed)).toBe(true)
    expect(isFileReviewed({ ...file, fingerprint: 'after' }, reviewed)).toBe(false)
    expect(isFileReviewed({ ...file, fingerprint: undefined }, reviewed)).toBe(false)
    expect(updateReviewed(reviewed, [file], false)).toEqual({})
  })
  test('polls preserve tab identity, content changes reload, missing files close', () => {
    const base = { mode: 'snapshot', ref: 'hash' }
    const file = { path: 'a.js', fingerprint: 'content', status: 'modified' }
    const tabs = [{ ...file, base }]
    expect(reconcileReviewTabs(tabs, [{ ...file }], { ...base })).toBe(tabs)
    expect(reconcileReviewTabs(tabs, [{ ...file, fingerprint: 'changed' }], base)[0]).not.toBe(
      tabs[0]
    )
    expect(reconcileReviewTabs(tabs, [file], { ...base, ref: 'another' })[0].base.ref).toBe(
      'another'
    )
    expect(reconcileReviewTabs(tabs, [], base)).toEqual([])
  })
  test('closing active tab selects its next neighbor, then the previous one', () => {
    const tabs = ['a', 'b', 'c'].map((path) => ({ path }))
    expect(closeReviewTab({ tabs, active: 'b' }, 'b').active).toBe('c')
    expect(closeReviewTab({ tabs, active: 'c' }, 'c').active).toBe('b')
    expect(closeReviewTab({ tabs, active: 'a' }, 'b').active).toBe('a')
    expect(closeReviewTab({ tabs: [{ path: 'a' }], active: 'a' }, 'a').active).toBeNull()
  })
})
