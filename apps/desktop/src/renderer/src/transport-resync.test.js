import { expect, it } from 'bun:test'
import { ensureMicaApi } from './transport'

it('在重连、可见恢复和桥通知时同步，并合并隐藏期间的通知', async () => {
  const documentEvents = new Map()
  const signals = []
  const sources = []
  globalThis.document = {
    hidden: false,
    addEventListener: (name, handler) => documentEvents.set(name, handler)
  }
  globalThis.window = {
    location: { pathname: '/' },
    addEventListener: () => {},
    dispatchEvent: (event) => signals.push(event.type)
  }
  globalThis.CustomEvent = class { constructor(type) { this.type = type } }
  globalThis.EventSource = class {
    static CLOSED = 2
    constructor() { sources.push(this) }
  }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  await ensureMicaApi()
  const source = sources[0]
  source.onopen()
  expect(signals).toEqual(['mica:transport-resync'])
  source.onopen()
  expect(signals).toHaveLength(2)
  document.hidden = true
  documentEvents.get('visibilitychange')()
  source.onopen()
  source.onmessage({ data: JSON.stringify({ channel: 'transport:resync' }) })
  expect(signals).toHaveLength(2)
  document.hidden = false
  documentEvents.get('visibilitychange')()
  expect(signals).toHaveLength(3)
  source.onmessage({ data: JSON.stringify({ channel: 'transport:resync' }) })
  expect(signals).toHaveLength(4)
})
