import assert from 'node:assert/strict'
import { test } from 'bun:test'
import {
  CLIENT_CONTEXT_CHANNEL,
  createClientContextHandler,
  isClientSenderAllowed
} from './client-context.js'

const ORIGIN = 'http://127.0.0.1:3210'
const MAX_BODY_BYTES = 256 * 1024 + 4096
const EVENT = { sender: {}, senderFrame: {} }

function windowFixture(origin = ORIGIN) {
  const frame = { url: `${origin}/?t=machine-a` }
  const sender = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false }
  const state = {
    clientOrigin: origin,
    win: { isDestroyed: () => false, webContents: sender }
  }
  return { frame, sender, state, event: { sender, senderFrame: frame }, windows: new Set([state]) }
}

function setup(overrides = {}) {
  const calls = []
  const dependency =
    (name, result) =>
    async (...args) => {
      calls.push([name, ...args])
      return result
    }
  const handler = createClientContextHandler({
    isAllowedSender: (event) => event === EVENT,
    manifests: [{ id: 'connections', desktopClientData: true }],
    readDisabled: () => [],
    readData: dependency('readData', { value: { connections: [] }, version: 'v1' }),
    writeData: dependency('writeData', { ok: true, version: 'v2' }),
    probe: dependency('probe', { reachable: true }),
    open: dependency('open', { opened: true }),
    local: dependency('local', { focused: true }),
    localHost: dependency('localHost', ORIGIN),
    ...overrides
  })
  return { calls, handler }
}

async function rejected(handler, operation, payload, message) {
  const result = await handler(EVENT, operation, payload)
  assert.equal(result.ok, false)
  assert.equal(typeof result.error, 'string')
  assert.deepEqual(Object.keys(result).sort(), ['error', 'ok'])
  if (message) assert.match(result.error, message)
}

test('exports the single native channel and authorizes registered top-level HTTP(S) senders', () => {
  assert.equal(CLIENT_CONTEXT_CHANNEL, 'mica:client-context')
  for (const origin of [ORIGIN, 'https://relay.example']) {
    const { windows, event } = windowFixture(origin)
    assert.equal(isClientSenderAllowed(windows, event), true)
  }
})

test('rejects same-origin iframes even when their URLs equal the main frame URL', () => {
  const { windows, event, frame } = windowFixture()
  assert.equal(isClientSenderAllowed(windows, { ...event, senderFrame: { ...frame } }), false)
  assert.equal(isClientSenderAllowed(windows, { ...event, senderFrame: null }), false)
})

test('rejects an unregistered window even if another registered window has the same origin', () => {
  const registered = windowFixture()
  const other = windowFixture()
  assert.equal(isClientSenderAllowed(registered.windows, other.event), false)
  assert.equal(isClientSenderAllowed(new Set(), registered.event), false)
})

test('requires approved origin, live frame origin and webContents URL origin to match', () => {
  const { windows, event, frame, sender, state } = windowFixture()
  sender.getURL = () => 'https://login.example/'
  assert.equal(isClientSenderAllowed(windows, event), false)
  sender.getURL = () => `${ORIGIN}/`
  frame.url = 'https://login.example/'
  assert.equal(isClientSenderAllowed(windows, event), false)
  sender.getURL = () => frame.url
  assert.equal(isClientSenderAllowed(windows, event), false)
  state.clientOrigin = 'https://login.example'
  assert.equal(isClientSenderAllowed(windows, event), true)
  state.clientOrigin = null
  assert.equal(isClientSenderAllowed(windows, event), false)
})

test('rejects destroyed windows, destroyed contents, detached frames and URL failures', () => {
  const { windows, event, state, sender } = windowFixture()
  state.win.isDestroyed = () => true
  assert.equal(isClientSenderAllowed(windows, event), false)
  state.win.isDestroyed = () => false
  sender.isDestroyed = () => true
  assert.equal(isClientSenderAllowed(windows, event), false)
  sender.isDestroyed = () => false
  sender.getURL = () => {
    throw new Error('destroyed')
  }
  assert.equal(isClientSenderAllowed(windows, event), false)
  Object.defineProperty(event, 'senderFrame', {
    get() {
      throw new Error('detached')
    }
  })
  assert.equal(isClientSenderAllowed(windows, event), false)
  assert.equal(isClientSenderAllowed(windows, null), false)
})

test('only permits HTTP(S) URLs, including when all three origins otherwise agree', () => {
  for (const url of [
    'file:///tmp/app.html',
    'about:blank',
    'data:text/html,test',
    'mica://host/',
    'garbage'
  ]) {
    const { windows, event, frame, state } = windowFixture()
    frame.url = url
    state.clientOrigin = url
    assert.equal(isClientSenderAllowed(windows, event), false)
  }
  const { windows, event, frame } = windowFixture()
  for (const url of [
    'about:blank',
    'http://127.0.0.1:3211/',
    'http://localhost:3210/',
    'https://127.0.0.1:3210/'
  ]) {
    frame.url = url
    assert.equal(isClientSenderAllowed(windows, event), false)
  }
})

test('checks exact event authorization first on every call and fails closed on errors', async () => {
  let allowed = true
  const seen = []
  const { handler, calls } = setup({
    isAllowedSender: async (event) => {
      seen.push(event)
      return allowed && event === EVENT
    }
  })
  assert.deepEqual(await handler(EVENT, 'context'), { ok: true, result: { localHost: ORIGIN } })
  allowed = false
  const payload = Object.defineProperty({}, 'value', {
    get() {
      throw new Error('must not read')
    }
  })
  assert.deepEqual(await handler(EVENT, '/invalid', payload), {
    ok: false,
    error: 'Forbidden sender'
  })
  const otherEvent = {}
  assert.deepEqual(await handler(otherEvent, 'local'), { ok: false, error: 'Forbidden sender' })
  assert.deepEqual(seen, [EVENT, EVENT, otherEvent])
  assert.equal(calls.length, 1)
  for (const isAllowedSender of [
    () => false,
    () => {
      throw new Error('closed')
    },
    async () => {
      throw new Error('closed')
    }
  ]) {
    const blocked = setup({ isAllowedSender })
    assert.deepEqual(await blocked.handler(EVENT, 'local'), {
      ok: false,
      error: 'Forbidden sender'
    })
    assert.deepEqual(blocked.calls, [])
  }
})

test('sender identity is enforced by the handler for same-origin other windows and frames', async () => {
  const { windows, event, frame, state } = windowFixture()
  const { handler, calls } = setup({
    isAllowedSender: (value) => isClientSenderAllowed(windows, value)
  })
  assert.equal((await handler(event, 'local')).ok, true)
  assert.equal((await handler({ ...event, senderFrame: { ...frame } }, 'local')).ok, false)
  assert.equal((await handler(windowFixture().event, 'local')).ok, false)
  frame.url = 'https://redirect.example/'
  assert.equal((await handler(event, 'local')).ok, false)
  frame.url = `${ORIGIN}/`
  state.win.isDestroyed = () => true
  assert.equal((await handler(event, 'local')).ok, false)
  assert.deepEqual(calls, [['local']])
})

test('accepts only six exact operation names, never paths or arbitrary channels', async () => {
  const { handler, calls } = setup()
  for (const operation of [
    undefined,
    null,
    {},
    [],
    1,
    'unknown',
    '/local',
    'local/',
    'LOCAL',
    'mica:client-context',
    'shell:openExternal',
    'mica-client://host/local',
    '__proto__',
    'constructor'
  ]) {
    await rejected(handler, operation, {}, /Unknown client operation/)
  }
  assert.deepEqual(calls, [])
})

test('reads opted-in data and passes write values and CAS conflicts through unchanged', async () => {
  const conflict = { ok: false, conflict: true, value: { connections: ['new'] }, version: 'v2' }
  const { handler, calls } = setup({
    writeData: async (...args) => {
      calls.push(['writeData', ...args])
      return conflict
    }
  })
  assert.deepEqual(await handler(EVENT, 'read-data', { pluginId: 'connections' }), {
    ok: true,
    result: { value: { connections: [] }, version: 'v1' }
  })
  const write = await handler(EVENT, 'write-data', {
    pluginId: 'connections',
    value: { connections: [] },
    expectedVersion: 'v1'
  })
  assert.equal(write.result, conflict)
  assert.deepEqual(write, { ok: true, result: conflict })
  assert.deepEqual(calls, [
    ['readData', 'connections'],
    ['writeData', 'connections', { connections: [] }, { expectedVersion: 'v1' }]
  ])
})

test('preserves omitted, null and empty expectedVersion as distinct CAS requests', async () => {
  const { handler, calls } = setup()
  for (const extra of [{}, { expectedVersion: null }, { expectedVersion: '' }]) {
    assert.equal(
      (await handler(EVENT, 'write-data', { pluginId: 'connections', value: null, ...extra })).ok,
      true
    )
  }
  assert.deepEqual(calls, [
    ['writeData', 'connections', null],
    ['writeData', 'connections', null, { expectedVersion: null }],
    ['writeData', 'connections', null, { expectedVersion: '' }]
  ])
})

test('requires literal opt-in and checks disabled ids dynamically for reads and writes', async () => {
  for (const manifest of [
    undefined,
    { id: 'connections' },
    { id: 'connections', desktopClientData: false },
    { id: 'connections', desktopClientData: 'true' }
  ]) {
    const { handler, calls } = setup({ manifests: manifest ? [manifest] : [] })
    for (const operation of ['read-data', 'write-data']) {
      await rejected(handler, operation, { pluginId: 'connections', value: {} }, /not enabled/)
    }
    assert.deepEqual(calls, [])
  }
  let disabled = []
  const { handler, calls } = setup({
    manifests: async () => [{ id: 'connections', desktopClientData: true }],
    readDisabled: async () => new Set(disabled)
  })
  assert.equal((await handler(EVENT, 'read-data', { pluginId: 'connections' })).ok, true)
  disabled = ['connections']
  for (const operation of ['read-data', 'write-data']) {
    await rejected(handler, operation, { pluginId: 'connections', value: {} }, /not enabled/)
  }
  assert.equal(calls.length, 1)
})

test('validates data ids and requires an own write value', async () => {
  const { handler, calls } = setup()
  for (const pluginId of [null, '', '../secrets', 'UPPER', {}, 1]) {
    await rejected(handler, 'read-data', { pluginId }, /Invalid pluginId/)
  }
  await rejected(handler, 'read-data', {}, /Invalid pluginId/)
  await rejected(handler, 'write-data', { pluginId: 'connections' }, /Missing value/)
  assert.deepEqual(calls, [])
})

test('runtime capabilities do not require data opt-in and return plain envelopes', async () => {
  const { handler, calls } = setup({
    manifests: [],
    readDisabled: () => {
      throw new Error('not needed')
    }
  })
  for (const [operation, payload, result] of [
    ['probe', { address: 'server:3210' }, { reachable: true }],
    ['open', { url: 'https://server.example/chat' }, { opened: true }],
    ['open', { url: 'http://server.example/chat' }, { opened: true }],
    ['local', {}, { focused: true }],
    ['context', {}, { localHost: ORIGIN }]
  ]) {
    const response = await handler(EVENT, operation, payload)
    assert.equal(Object.getPrototypeOf(response), Object.prototype)
    assert.deepEqual(response, { ok: true, result })
  }
  assert.deepEqual(calls, [
    ['probe', 'server:3210'],
    ['open', 'https://server.example/chat'],
    ['open', 'http://server.example/chat'],
    ['local'],
    ['localHost']
  ])
})

test('rejects malformed probe targets and all non-HTTP open URLs', async () => {
  const { handler, calls } = setup()
  for (const url of [
    null,
    {},
    '',
    '/local',
    '//server',
    'https://',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'mica-client://host/local',
    'data:text/plain,hello',
    'ftp://server'
  ]) {
    await rejected(handler, 'open', { url }, /Only HTTP and HTTPS/)
  }
  await rejected(handler, 'open', {}, /Only HTTP and HTTPS/)
  for (const address of [null, {}, '', '   ', 123]) {
    await rejected(handler, 'probe', { address }, /Invalid address/)
  }
  await rejected(handler, 'probe', {}, /Invalid address/)
  await rejected(
    handler,
    'open',
    { channel: 'shell:openExternal', path: '/tmp/file' },
    /Only HTTP and HTTPS/
  )
  assert.deepEqual(calls, [])
})

test('requires a plain root object and strict JSON-compatible values', async () => {
  const { handler, calls } = setup()
  for (const payload of [
    null,
    [],
    true,
    1,
    'text',
    new Date(),
    new Map(),
    Object.create({ value: 1 })
  ]) {
    await rejected(handler, 'local', payload, /plain object/)
  }
  for (const value of [
    undefined,
    1n,
    NaN,
    Infinity,
    -Infinity,
    Symbol('x'),
    () => {},
    new Date(),
    new Set(),
    new Uint8Array(1),
    [,],
    Object.assign([], { extra: true })
  ]) {
    await rejected(handler, 'local', { value }, /Invalid JSON/)
  }
  await rejected(handler, 'local', { [Symbol('x')]: true }, /Invalid JSON/)
  assert.deepEqual(calls, [])
  assert.equal((await handler(EVENT, 'local', Object.create(null))).ok, true)
  assert.equal((await handler(EVENT, 'local')).ok, true)
})

test('rejects cycles and accessors without executing getters or toJSON', async () => {
  const { handler, calls } = setup()
  const circular = {}
  circular.self = circular
  const array = []
  array.push(array)
  for (const payload of [
    circular,
    { value: array },
    {
      toJSON() {
        throw new Error('must not invoke')
      }
    }
  ]) {
    await rejected(handler, 'local', payload, /Invalid JSON/)
  }
  let accessed = false
  const getter = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      accessed = true
      return {}
    }
  })
  await rejected(handler, 'local', getter, /Invalid JSON/)
  assert.equal(accessed, false)
  assert.deepEqual(calls, [])
  const shared = { x: true }
  assert.equal((await handler(EVENT, 'local', { first: shared, second: shared })).ok, true)
})

test('allows a 256 KiB value and enforces the exact UTF-8 JSON envelope limit', async () => {
  const { handler, calls } = setup()
  assert.equal(
    (await handler(EVENT, 'write-data', { pluginId: 'connections', value: 'x'.repeat(256 * 1024) }))
      .ok,
    true
  )
  const envelopeSize = Buffer.byteLength(JSON.stringify({ value: '' }))
  assert.equal(
    (await handler(EVENT, 'local', { value: 'x'.repeat(MAX_BODY_BYTES - envelopeSize) })).ok,
    true
  )
  for (const payload of [
    { value: 'x'.repeat(MAX_BODY_BYTES - envelopeSize + 1) },
    { value: '界'.repeat(100_000) },
    { value: '\n'.repeat(MAX_BODY_BYTES / 2) },
    { ['界'.repeat(100_000)]: true },
    { value: Array(100_000).fill(null) }
  ]) {
    await rejected(handler, 'local', payload, /too large/)
  }
  assert.equal(calls.length, 2)
})

test('rejects very deep or unbounded payload graphs without invoking a capability', async () => {
  const { handler, calls } = setup()
  const payload = {}
  let node = payload
  for (let index = 0; index < MAX_BODY_BYTES; index++) node = node.next = {}
  await rejected(handler, 'local', payload, /too large/)
  assert.deepEqual(calls, [])
})

test('returns dependency failures and normalizes undefined success results to null', async () => {
  for (const thrown of [new Error('No local window'), 'plain failure', null]) {
    const { handler } = setup({
      local: () => {
        throw thrown
      }
    })
    assert.deepEqual(await handler(EVENT, 'local'), {
      ok: false,
      error: thrown instanceof Error ? thrown.message : String(thrown)
    })
  }
  for (const dependency of ['manifests', 'readDisabled', 'readData', 'writeData']) {
    const { handler, calls } = setup({
      [dependency]: async () => {
        throw new Error(`${dependency} failed`)
      }
    })
    await rejected(
      handler,
      dependency === 'writeData' ? 'write-data' : 'read-data',
      { pluginId: 'connections', value: {} },
      /failed/
    )
    assert.deepEqual(calls, [])
  }
  assert.deepEqual(await setup({ local: () => {} }).handler(EVENT, 'local'), {
    ok: true,
    result: null
  })
})
