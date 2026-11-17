import { describe, expect, test } from 'bun:test'
import { observePluginSurface } from './plugin-experience.js'

function fixture(visibility = 'visible', focused = true) {
  let callback
  const recorded = []
  const listeners = new Map()
  const element = { addEventListener: (name, listener) => listeners.set(name, listener), removeEventListener: (name) => listeners.delete(name) }
  const doc = { visibilityState: visibility, hasFocus: () => focused, addEventListener() {}, removeEventListener() {} }
  class Observer {
    constructor(cb) { callback = cb }
    observe() {}
    disconnect() { this.disconnected = true }
  }
  const dispose = observePluginSurface(element, (...args) => recorded.push(args), 'page', { document: doc, Observer })
  return { doc, recorded, listeners, element, dispose, appear: (visible = true) => callback([{ target: element, isIntersecting: true, isVisible: visible }]) }
}

describe('plugin actual visibility metadata', () => {
  test('does not count a hidden/preloaded or occluded page as an impression', () => {
    const f = fixture('hidden')
    f.appear()
    expect(f.recorded).toEqual([])
    f.doc.visibilityState = 'visible'
    f.appear(false)
    expect(f.recorded).toEqual([])
    f.appear()
    f.appear()
    expect(f.recorded).toEqual([['impression', { surface: 'page', action: 'view' }]])
    f.dispose()
  })
  test('counts only control activation without copying element text or attributes', () => {
    const f = fixture()
    f.listeners.get('click')({ target: { textContent: 'private', closest: () => ({ href: 'https://private' }) } })
    expect(f.recorded).toEqual([['click', { surface: 'page', action: 'activate' }]])
    f.dispose()
    expect(f.listeners.size).toBe(0)
  })
  test('unsupported visibility observation never blocks the plugin', () => {
    expect(() => observePluginSurface({ addEventListener() {}, removeEventListener() {} }, () => {}, 'page', {
      document: { addEventListener() {}, removeEventListener() {} },
      Observer: class { constructor() { throw new Error('unsupported') } }
    })).not.toThrow()
  })
})
