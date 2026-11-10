import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CLIENT_SCHEME,
  createClientContextHandler,
  isClientOriginAllowed
} from './client-context.js'

const ORIGIN = 'http://127.0.0.1:3210'
const MAX_BODY_BYTES = 256 * 1024 + 4096

test('redirected pages do not inherit the shell-approved entry origin', () => {
  let url = `${ORIGIN}/?t=machine-a`
  let destroyed = false
  const windows = new Set([
    {
      clientOrigin: ORIGIN,
      win: { isDestroyed: () => destroyed, webContents: { getURL: () => url } }
    }
  ])
  assert.equal(isClientOriginAllowed(windows, ORIGIN), true)
  url = 'https://login.example/'
  assert.equal(isClientOriginAllowed(windows, 'https://login.example'), false)
  assert.equal(isClientOriginAllowed(windows, ORIGIN), false)
  url = `${ORIGIN}/`
  destroyed = true
  assert.equal(isClientOriginAllowed(windows, ORIGIN), false)
})

function setup(overrides = {}) {
  const calls = []
  const dependency =
    (name, result) =>
    async (...args) => {
      calls.push([name, ...args])
      return result
    }
  const handler = createClientContextHandler({
    isAllowedOrigin: (origin) => origin === ORIGIN,
    manifests: [{ id: 'connections', desktopClientData: true }],
    readDisabled: () => [],
    readData: dependency('readData', { value: { connections: [] }, version: 'v1' }),
    writeData: dependency('writeData', { ok: true, version: 'v2' }),
    probe: dependency('probe', { reachable: true }),
    open: dependency('open', { opened: true }),
    local: dependency('local', { focused: true }),
    localHost: dependency('localHost', 'http://127.0.0.1:3210'),
    ...overrides
  })
  return { calls, handler }
}

function request(path, body = {}, options = {}) {
  const { origin = ORIGIN, method = 'POST', url, headers = {}, rawBody, ...rest } = options
  const result = new Request(url ?? `${CLIENT_SCHEME}://host${path}`, {
    method,
    headers: {
      ...(origin === null ? {} : { Origin: origin }),
      'Content-Type': 'application/json',
      ...headers
    },
    ...(method === 'GET' || method === 'OPTIONS' ? {} : { body: rawBody ?? JSON.stringify(body) }),
    ...rest
  })
  // Bun's Request currently ignores RequestInit.referrer; Electron supplies it.
  if (Object.hasOwn(rest, 'referrer'))
    Object.defineProperty(result, 'referrer', { value: rest.referrer })
  return result
}

async function rejected(handler, req, status, cors = true) {
  const response = await handler(req)
  assert.equal(response.status, status)
  assert.equal(response.headers.get('access-control-allow-origin'), cors ? ORIGIN : null)
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(typeof body.error, 'string')
}

test('rejects absent, opaque and untrusted origins before invoking capabilities', async () => {
  const { handler, calls } = setup()
  for (const origin of [null, 'null', '', 'https://untrusted.example', `${ORIGIN}.evil.example`]) {
    for (const method of ['POST', 'OPTIONS']) {
      await rejected(handler, request('/local', {}, { origin, method }), 403, false)
    }
  }
  assert.deepEqual(calls, [])
})

test('checks live origin authorization for every request and fails closed on errors', async () => {
  let allowed = true
  const { handler } = setup({ isAllowedOrigin: async () => allowed })
  assert.equal((await handler(request('/context'))).status, 200)
  allowed = false
  await rejected(handler, request('/context'), 403, false)
  const throwing = setup({
    isAllowedOrigin: () => {
      throw new Error('window closed')
    }
  })
  await rejected(throwing.handler, request('/context'), 403, false)
})

test('Electron 39 authorizes its browser-validated referrer when Origin is omitted', async () => {
  const { handler } = setup()
  const response = await handler(
    request('/context', {}, { origin: null, referrer: `${ORIGIN}/?t=secret` })
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN)
  await rejected(handler, request('/context', {}, { origin: 'null', referrer: ORIGIN }), 403, false)
  await rejected(
    handler,
    request('/context', {}, { origin: null, referrer: 'https://untrusted.example/' }),
    403,
    false
  )
})

test('only serves the protocol host and known paths with POST or OPTIONS', async () => {
  const { handler, calls } = setup()
  for (const url of [
    'mica-client://other/local',
    'mica-client://host.evil/local',
    'https://host/local'
  ]) {
    await rejected(handler, request('/local', {}, { url }), 403, false)
  }
  await rejected(handler, request('/unknown'), 404)
  await rejected(handler, request('/context', {}, { method: 'GET' }), 405)
  assert.deepEqual(calls, [])
})

test('returns exact-origin CORS preflight without invoking a capability', async () => {
  const { handler, calls } = setup()
  const response = await handler(request('/write-data', {}, { method: 'OPTIONS' }))
  assert.equal(response.status, 204)
  assert.equal(await response.text(), '')
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN)
  assert.equal(response.headers.get('access-control-allow-methods'), 'POST, OPTIONS')
  assert.equal(response.headers.get('access-control-allow-headers'), 'content-type')
  assert.equal(response.headers.get('vary'), 'Origin')
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
  const read = await handler(request('/read-data', { pluginId: 'connections' }))
  assert.deepEqual(await read.json(), {
    ok: true,
    result: { value: { connections: [] }, version: 'v1' }
  })
  const write = await handler(
    request('/write-data', {
      pluginId: 'connections',
      value: { connections: [] },
      expectedVersion: 'v1'
    })
  )
  assert.deepEqual(await write.json(), { ok: true, result: conflict })
  assert.deepEqual(calls, [
    ['readData', 'connections'],
    ['writeData', 'connections', { connections: [] }, { expectedVersion: 'v1' }]
  ])
})

test('distinguishes omitted expectedVersion from explicit null or empty versions', async () => {
  const { handler, calls } = setup()
  for (const extra of [{}, { expectedVersion: null }, { expectedVersion: '' }]) {
    const response = await handler(
      request('/write-data', { pluginId: 'connections', value: null, ...extra })
    )
    assert.equal(response.status, 200)
  }
  assert.deepEqual(calls, [
    ['writeData', 'connections', null],
    ['writeData', 'connections', null, { expectedVersion: null }],
    ['writeData', 'connections', null, { expectedVersion: '' }]
  ])
})

test('requires a known manifest with literal true and checks disabled ids dynamically', async () => {
  for (const manifest of [
    undefined,
    { id: 'connections' },
    { id: 'connections', desktopClientData: false },
    { id: 'connections', desktopClientData: 'true' }
  ]) {
    const { handler, calls } = setup({ manifests: manifest ? [manifest] : [] })
    for (const path of ['/read-data', '/write-data']) {
      await rejected(handler, request(path, { pluginId: 'connections', value: {} }), 403, false)
    }
    assert.deepEqual(calls, [])
  }
  let disabled = []
  const { handler, calls } = setup({
    manifests: async () => [{ id: 'connections', desktopClientData: true }],
    readDisabled: async () => new Set(disabled)
  })
  assert.equal((await handler(request('/read-data', { pluginId: 'connections' }))).status, 200)
  disabled = ['connections']
  await rejected(handler, request('/read-data', { pluginId: 'connections' }), 403, false)
  await rejected(
    handler,
    request('/write-data', { pluginId: 'connections', value: {} }),
    403,
    false
  )
  assert.equal(calls.length, 1)
})

test('validates data ids and requires a write value', async () => {
  const { handler, calls } = setup()
  for (const pluginId of [undefined, null, '', '../secrets', 'UPPER', {}, 1]) {
    await rejected(handler, request('/read-data', { pluginId }), 400)
  }
  await rejected(handler, request('/write-data', { pluginId: 'connections' }), 400)
  assert.deepEqual(calls, [])
})

test('runtime capabilities do not require a plugin data opt-in', async () => {
  const { handler, calls } = setup({
    manifests: [],
    readDisabled: () => {
      throw new Error('not needed')
    }
  })
  for (const [path, body, result] of [
    ['/probe', { address: 'server:3210' }, { reachable: true }],
    ['/open', { url: 'https://server.example/chat' }, { opened: true }],
    ['/open', { url: 'http://server.example/chat' }, { opened: true }],
    ['/local', {}, { focused: true }],
    ['/context', {}, { localHost: ORIGIN }]
  ]) {
    const response = await handler(request(path, body))
    assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN)
    assert.deepEqual(await response.json(), { ok: true, result })
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
    undefined,
    null,
    {},
    '',
    '/local',
    '//server',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'mica-client://host/local',
    'data:text/plain,hello',
    'ftp://server'
  ]) {
    await rejected(handler, request('/open', { url }), 400)
  }
  for (const address of [undefined, null, {}, '', '   ']) {
    await rejected(handler, request('/probe', { address }), 400)
  }
  assert.deepEqual(calls, [])
})

test('handles media types, bad JSON, non-object bodies and malformed UTF-8', async () => {
  const { handler, calls } = setup()
  await rejected(handler, request('/local', {}, { headers: { 'Content-Type': 'text/plain' } }), 415)
  for (const rawBody of ['', '{', 'null', '[]', 'true', '1', '"text"', new Uint8Array([0xff])]) {
    await rejected(handler, request('/local', {}, { rawBody }), 400)
  }
  assert.deepEqual(calls, [])
  assert.equal(
    (
      await handler(
        request('/local', {}, { headers: { 'Content-Type': 'application/json; charset=utf-8' } })
      )
    ).status,
    200
  )
})

test('allows a 256 KiB value with envelope but bounds actual and declared body bytes', async () => {
  const { handler, calls } = setup()
  assert.equal(
    (
      await handler(
        request('/write-data', { pluginId: 'connections', value: 'x'.repeat(256 * 1024) })
      )
    ).status,
    200
  )
  await rejected(handler, request('/local', { value: 'x'.repeat(MAX_BODY_BYTES) }), 413)
  await rejected(
    handler,
    request('/local', {}, { headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) } }),
    413
  )
  // UTF-8 byte count, rather than JS character count, controls the limit.
  await rejected(handler, request('/local', { value: '界'.repeat(100_000) }), 413)
  assert.equal(calls.length, 1)
})

test('stops a streaming body at the size limit even with an understated content length', async () => {
  let cancelled = false
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(64 * 1024))
    },
    cancel() {
      cancelled = true
    }
  })
  const { handler, calls } = setup()
  await rejected(
    handler,
    request(
      '/local',
      {},
      {
        rawBody: stream,
        duplex: 'half',
        headers: { 'Content-Length': '2' }
      }
    ),
    413
  )
  assert.equal(cancelled, true)
  assert.deepEqual(calls, [])
})

test('serializes dependency errors and undefined capability results', async () => {
  const { handler } = setup({
    local: () => {
      throw new Error('No local window')
    }
  })
  const response = await handler(request('/local'))
  assert.equal(response.status, 500)
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN)
  assert.deepEqual(await response.json(), { ok: false, error: 'No local window' })
  const empty = setup({ local: () => {} })
  assert.deepEqual(await (await empty.handler(request('/local'))).json(), {
    ok: true,
    result: null
  })
})
