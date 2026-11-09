import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { isModalOpen, ModalMeta, registerModal } from './chat-modal'

const cleanups = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  expect(isModalOpen()).toBe(false)
})

function modalEvents() {
  const target = new EventTarget()
  let configModalOpen = false
  const document = {
    querySelector: (selector) =>
      selector === '[data-mica-config-modal]' && configModalOpen ? {} : null
  }
  return {
    target,
    add(entry) {
      const cleanup = registerModal(entry, target, document)
      cleanups.push(cleanup)
      return cleanup
    },
    escape(key = 'Escape') {
      const event = new Event('keydown', { cancelable: true })
      Object.defineProperty(event, 'key', { value: key })
      target.dispatchEvent(event)
      return event
    },
    setConfigModalOpen(value) {
      configModalOpen = value
    }
  }
}

describe('ModalShell dismissal stack', () => {
  test('tracks open modals and only dismisses the most recently opened layer', () => {
    const events = modalEvents()
    const closed = []
    events.add({ close: () => closed.push('outer') })
    const closeInner = events.add({ close: () => closed.push('inner') })

    expect(isModalOpen()).toBe(true)
    expect(events.escape('Enter').defaultPrevented).toBe(false)
    expect(closed).toEqual([])
    expect(events.escape().defaultPrevented).toBe(true)
    expect(closed).toEqual(['inner'])

    closeInner()
    events.escape()
    expect(closed).toEqual(['inner', 'outer'])
  })

  test('keeps the child on top when its mount effect runs before its parent', () => {
    const events = modalEvents()
    const closed = []
    const outer = { close: () => closed.push('outer') }
    const inner = { parent: outer, close: () => closed.push('inner') }
    events.add(inner)
    events.add(outer)

    events.escape()
    expect(closed).toEqual(['inner'])
  })

  test('yields Escape to a config detail portal without cancelling its keyboard event', () => {
    const events = modalEvents()
    let closed = 0
    let configKeyEvents = 0
    events.add({ close: () => closed++ })
    events.target.addEventListener('keydown', () => configKeyEvents++)

    events.setConfigModalOpen(true)
    expect(events.escape().defaultPrevented).toBe(false)
    expect(closed).toBe(0)
    expect(configKeyEvents).toBe(1)

    events.setConfigModalOpen(false)
    events.escape()
    expect(closed).toBe(1)
    expect(configKeyEvents).toBe(1)
  })

  test('does not close a lower layer in the same Escape event when the top unmounts synchronously', () => {
    const events = modalEvents()
    const closed = []
    const outer = { close: () => closed.push('outer') }
    let removeInner
    const inner = {
      parent: outer,
      close: () => {
        closed.push('inner')
        removeInner()
      }
    }
    removeInner = events.add(inner)
    events.add(outer)

    events.escape()
    expect(closed).toEqual(['inner'])
    events.escape()
    expect(closed).toEqual(['inner', 'outer'])
  })

  test('cleanup is idempotent and removing a lower modal preserves the current top', () => {
    const events = modalEvents()
    const closed = []
    const removeOuter = events.add({ close: () => closed.push('outer') })
    events.add({ close: () => closed.push('inner') })

    removeOuter()
    removeOuter()
    expect(isModalOpen()).toBe(true)
    events.escape()
    expect(closed).toEqual(['inner'])
  })

  test('reads the current close callback without registering a new layer', () => {
    const events = modalEvents()
    const closed = []
    const entry = { close: () => closed.push('old') }
    events.add(entry)
    entry.close = () => closed.push('new')

    events.escape()
    expect(closed).toEqual(['new'])
  })
})

describe('ModalMeta', () => {
  test('omits absent values without losing zero and inserts separators only between visible items', () => {
    const html = renderToStaticMarkup(<ModalMeta items={[null, '', 'Ready', undefined, 0]} />)
    expect(html.match(/chat-modal-meta-item/g)).toHaveLength(2)
    expect(html.match(/chat-modal-sep/g)).toHaveLength(1)
    expect(html).toContain('Ready')
    expect(html).toContain('</span>0</span>')
    expect(renderToStaticMarkup(<ModalMeta items={[null, undefined, '']} />)).toBe('')
  })
})
