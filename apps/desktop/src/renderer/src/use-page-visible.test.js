import { describe, expect, it } from 'bun:test'
import { pageIsActive } from './use-page-visible.js'

describe('background view polling gate', () => {
  it('only polls a visible and focused page', () => {
    expect(pageIsActive({ visibilityState: 'visible', hasFocus: () => true })).toBe(true)
    expect(pageIsActive({ visibilityState: 'visible', hasFocus: () => false })).toBe(false)
    expect(pageIsActive({ visibilityState: 'hidden', hasFocus: () => true })).toBe(false)
  })
})
