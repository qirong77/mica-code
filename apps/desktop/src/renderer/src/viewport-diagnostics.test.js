import { describe, expect, it } from 'bun:test'
import { startViewportDiagnostics, viewportDiagnosticSnapshot } from './viewport-diagnostics'

describe('viewport diagnostics', () => {
  it('does nothing without explicit opt-in, including making no network request', async () => {
    const win = {
      location: { search: '?session=private-session' },
      fetch: () => {
        throw new Error('normal pages must not send diagnostics')
      }
    }
    expect(await startViewportDiagnostics(win, {})).toBeUndefined()
  })

  it('requires the collector handshake instead of treating the SPA fallback as a collector', async () => {
    for (const response of [
      { ok: false },
      { ok: true, json: async () => ({ ok: true }) },
      {
        ok: true,
        json: async () => {
          throw new SyntaxError('HTML fallback')
        }
      }
    ]) {
      const win = { location: { search: '?viewport-debug=1' }, fetch: async () => response }
      expect(await startViewportDiagnostics(win, {})).toBeUndefined()
    }
  })

  it('captures hidden ancestor scrolling and geometry without reading input or chat contents', () => {
    const element = (tagName, parentElement = null) => ({
      tagName,
      parentElement,
      classList: [],
      clientHeight: 420,
      scrollHeight: 852,
      scrollTop: 432,
      scrollLeft: 0,
      closest: () => null,
      getBoundingClientRect: () => ({ top: -432, bottom: -12, height: 420, width: 440 }),
      get value() {
        throw new Error('must not read draft text')
      },
      get textContent() {
        throw new Error('must not read chat text')
      },
      get outerHTML() {
        throw new Error('must not serialize HTML')
      }
    })
    const html = element('HTML')
    const body = element('BODY', html)
    const root = element('DIV', body)
    const input = element('TEXTAREA', root)
    const doc = {
      documentElement: html,
      body,
      activeElement: input,
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => root
    }
    const win = {
      performance: { now: () => 1234.5 },
      visualViewport: { height: 420, scale: 1, offsetTop: 432, pageTop: 432 },
      innerHeight: 852,
      innerWidth: 440,
      scrollY: 0,
      scrollX: 0,
      getComputedStyle: () => ({
        overflowY: 'hidden',
        height: '420px',
        getPropertyValue: () => ''
      })
    }
    const snapshot = viewportDiagnosticSnapshot(win, doc, 'focusin', input)
    expect(snapshot.window.scrollY).toBe(0)
    expect(snapshot.elements.root.scrollTop).toBe(432)
    expect(snapshot.activeAncestors).toHaveLength(4)
    expect(snapshot.activeAncestors[0].rect.bottom).toBe(-12)
    expect(snapshot.elements.root.css.overflowY).toBe('hidden')
    expect(snapshot.viewport.offsetTop).toBe(432)
    expect(JSON.stringify(snapshot)).not.toContain('textContent')
  })
})
