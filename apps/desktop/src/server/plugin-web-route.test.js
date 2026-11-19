import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushLogs } from '@packages/mica-diagnostics/index.js'
import { createPluginWebRuntime } from '../host/plugin-web-runtime.js'
import { createPluginWebRoute, PLUGIN_WEB_MAX_BYTES } from './plugin-web-route.js'
import { servePluginPage } from './plugin-page-route.js'

mock.module('electron', () => ({ ipcMain: { handle() {} } }))
const { verifyRequestOrigin, resetAccessForTests } = await import('../host/access.js')

const runtimes = []
const directories = []
let originalLogs

beforeEach(() => {
  resetAccessForTests()
  originalLogs = process.env.MICA_LOG_DIR
  process.env.MICA_LOG_DIR = tempDir()
})

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  flushLogs()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (originalLogs === undefined) delete process.env.MICA_LOG_DIR
  else process.env.MICA_LOG_DIR = originalLogs
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mica-plugin-web-route-'))
  directories.push(dir)
  return dir
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function request(url, options = {}) {
  return Object.assign(new EventEmitter(), {
    url, method: 'GET', headers: { host: '127.0.0.1:8787' }, socket: { remoteAddress: '127.0.0.1' }, ...options
  })
}

function response() {
  return Object.assign(new EventEmitter(), {
    status: null, headers: null, body: '', writableEnded: false, destroyed: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; return this },
    end(body) { this.body = body ?? ''; this.writableEnded = true; return this }
  })
}

function fixture({ queries = { summary: () => ({ count: 1 }) }, loader, ...routeOptions } = {}) {
  const home = tempDir()
  const disabled = new Set()
  const manifests = [
    { id: 'demo', name: 'Demo', version: '1.0.0', web: true, desktopPage: { title: 'Console', route: 'console' } },
    { id: 'legacy', name: 'Legacy', version: '1.0.0', desktopPage: { title: 'Page' } },
    { id: 'launcher', name: 'Launcher', version: '1.0.0', desktopLauncher: { title: 'Launcher' } }
  ]
  let loads = 0
  const runtime = createPluginWebRuntime({
    manifests, home, readDisabled: () => disabled,
    loaders: new Map([['demo', async () => { loads += 1; return loader ? loader() : { default: () => ({ queries }) } }]])
  })
  runtimes.push(runtime)
  writeFileSync(join(home, 'index.html'), '<html><head></head><body>PAGE</body></html>')
  const route = createPluginWebRoute({
    runtime, manifests, readDisabled: () => disabled, verifyOrigin: verifyRequestOrigin,
    servePage: (req, res, allowed) => servePluginPage(req, res, home, allowed),
    ...routeOptions
  })
  const call = async (url, options) => {
    const req = request(url, options)
    const res = response()
    const handled = await route(req, res, url.split('?')[0])
    return { req, res, handled }
  }
  return { route, runtime, disabled, call, loads: () => loads }
}

describe('application /plugins namespace', () => {
  it('serves only the precise declared page route; a custom route has no default alias', async () => {
    const { call, disabled, loads } = fixture()
    for (const path of ['/plugins/demo/console', '/plugins/demo/console/', '/plugins/pages/legacy', '/plugins/pages/launcher']) {
      const { res, handled } = await call(path)
      expect(handled).toBe(true)
      expect(res.status).toBe(200)
      expect(res.body).toContain('<base href="/" />')
    }
    for (const path of ['/plugins', '/plugins/pages/demo', '/plugins/demo/other', '/plugins/demo/console/extra', '/plugins/pages/missing', '/plugins/demo/api/missing.json', '/%70lugins/demo/console']) {
      const { res, handled } = await call(path)
      expect(handled).toBe(true)
      expect(res.status).toBe(404)
    }
    disabled.add('demo')
    expect((await call('/plugins/demo/console')).res.status).toBe(404)
    disabled.add('launcher')
    expect((await call('/plugins/pages/launcher')).res.status).toBe(404)
    expect(loads()).toBe(0)
    expect((await call('/api/invoke')).handled).toBe(false)
  })

  it('applies the real Host/Origin guard even to loopback pages and queries before loading', async () => {
    const { call, loads } = fixture()
    for (const path of ['/plugins/demo/console', '/plugins/demo/api/summary']) {
      const badHost = await call(path, { headers: { host: 'not-this-host.invalid:8787' } })
      expect(badHost.res.status).toBe(403)
      const badOrigin = await call(path, { headers: { host: '127.0.0.1:8787', origin: 'https://not-this-host.invalid' } })
      expect(badOrigin.res.status).toBe(403)
      const sandbox = await call(path, { headers: { host: '127.0.0.1:8787', origin: 'null' } })
      expect(sandbox.res.status).toBe(403)
    }
    expect(loads()).toBe(0)
    expect((await call('/plugins/demo/api/summary', { headers: { host: '127.0.0.1:8787', origin: 'http://localhost:5173' } })).res.status).toBe(200)
  })

  it('only accepts GET queries, not HEAD/POST/OPTIONS, before module initialization', async () => {
    const { call, loads } = fixture()
    for (const method of ['HEAD', 'POST', 'OPTIONS', 'PUT', 'DELETE']) {
      const { res } = await call('/plugins/demo/api/summary', { method })
      expect(res.status).toBe(405)
      expect(res.headers.allow).toBe('GET')
    }
    expect(loads()).toBe(0)
    expect((await call('/plugins/demo/console', { method: 'HEAD' })).res.body).toBe('')
  })

  it('passes frozen string params, uses own-property queries, and redacts the operation log', async () => {
    const queries = Object.assign(Object.create({ inherited: () => 'must-not-run' }), {
      summary: (params, { signal }) => {
        expect(Object.getPrototypeOf(params)).toBeNull()
        expect(Object.isFrozen(params)).toBe(true)
        expect(params.sample).toBe('PRIVATE_INPUT_VALUE')
        expect(signal.aborted).toBe(false)
        return { sample: 'PRIVATE_OUTPUT_VALUE' }
      }
    })
    const { call } = fixture({ queries })
    const { res } = await call('/plugins/demo/api/summary?sample=PRIVATE_INPUT_VALUE')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, result: { sample: 'PRIVATE_OUTPUT_VALUE' } })
    for (const query of ['toString', 'constructor', '__proto__', 'inherited']) expect((await call(`/plugins/demo/api/${query}`)).res.status).toBe(404)
    flushLogs()
    const text = readdirSync(process.env.MICA_LOG_DIR).filter((file) => file.endsWith('.jsonl'))
      .map((file) => readFileSync(join(process.env.MICA_LOG_DIR, file), 'utf8')).join('\n')
    expect(text).toContain('web.read.summary')
    expect(text).toContain('"surface":"page"')
    expect(text).toContain('read_complete')
    expect(text).not.toContain('PRIVATE_INPUT_VALUE')
    expect(text).not.toContain('PRIVATE_OUTPUT_VALUE')
  })

  it('bounds parameter count, key/value/total lengths, duplicate keys and request bodies', async () => {
    const { call, loads } = fixture()
    const tooMany = new URLSearchParams(Array.from({ length: 17 }, (_, i) => [`p${i}`, 'x'])).toString()
    for (const search of [tooMany, `key=${'x'.repeat(2049)}`, `${'x'.repeat(65)}=1`, 'a=1&a=2', `a=${'x'.repeat(2048)}&b=${'x'.repeat(2048)}&c=${'x'.repeat(2048)}&d=${'x'.repeat(2048)}`]) {
      expect((await call(`/plugins/demo/api/summary?${search}`)).res.status).toBe(400)
    }
    expect((await call('/plugins/demo/api/summary', { headers: { host: '127.0.0.1', 'content-length': '1' } })).res.status).toBe(400)
    expect(loads()).toBe(0)
  })

  it('caps the serialized UTF-8 JSON envelope, not only character count, and sanitizes failures', async () => {
    const base = Buffer.byteLength(JSON.stringify({ ok: true, result: '' }))
    const cycle = {}; cycle.self = cycle
    const { call } = fixture({ queries: {
      exact: () => 'x'.repeat(PLUGIN_WEB_MAX_BYTES - base),
      large: () => 'é'.repeat(PLUGIN_WEB_MAX_BYTES / 2),
      cycle: () => cycle,
      fail: () => { throw new Error('INTERNAL_STACK_OR_SECRET') }
    } })
    const exact = (await call('/plugins/demo/api/exact')).res
    expect(exact.status).toBe(200)
    expect(Buffer.byteLength(exact.body)).toBe(PLUGIN_WEB_MAX_BYTES)
    expect((await call('/plugins/demo/api/large')).res.status).toBe(413)
    expect((await call('/plugins/demo/api/cycle')).res.status).toBe(500)
    const failed = (await call('/plugins/demo/api/fail')).res
    expect(failed.status).toBe(500)
    expect(failed.body).not.toContain('INTERNAL_STACK_OR_SECRET')
    expect(JSON.parse(failed.body).code).toBe('query_failed')
  })

  it('propagates timeout to the query and settles even if a plugin ignores it', async () => {
    let signal
    const { call } = fixture({ timeoutMs: 50, queries: { summary: (_params, context) => {
      signal = context.signal
      return new Promise(() => {})
    } } })
    const { res } = await call('/plugins/demo/api/summary')
    expect(res.status).toBe(504)
    expect(signal.aborted).toBe(true)
    expect(signal.reason.name).toBe('TimeoutError')
  })

  it('propagates disconnect without disposing the shared instance', async () => {
    const started = deferred()
    let signal
    let disposed = 0
    const { route, call } = fixture({ loader: async () => ({ default: () => ({
      queries: { summary: (_params, context) => {
        if (!signal) {
          signal = context.signal
          started.resolve()
          return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
        }
        return 'next-read'
      } }, dispose: () => { disposed += 1 }
    }) }) })
    const req = request('/plugins/demo/api/summary')
    const res = response()
    const pending = route(req, res, '/plugins/demo/api/summary')
    await started.promise
    req.emit('aborted')
    await pending
    expect(signal.aborted).toBe(true)
    expect(res.status).toBe(499)
    expect(disposed).toBe(0)
    expect((await call('/plugins/demo/api/summary')).res.status).toBe(200)
  })

  it('bounds load waiters and preserves shared initialization when one caller is cancelled', async () => {
    const started = deferred()
    const gate = deferred()
    let disposed = 0
    const { route, call, loads } = fixture({ maxConcurrent: 1, loader: async () => {
      started.resolve()
      await gate.promise
      return { default: () => ({ queries: { summary: () => 'ready' }, dispose: () => { disposed += 1 } }) }
    } })
    const req = request('/plugins/demo/api/summary')
    const pending = route(req, response(), '/plugins/demo/api/summary')
    await started.promise
    expect((await call('/plugins/demo/api/summary')).res.status).toBe(429)
    req.emit('aborted')
    await pending
    const next = call('/plugins/demo/api/summary')
    gate.resolve()
    expect((await next).res.status).toBe(200)
    expect(loads()).toBe(1)
    expect(disposed).toBe(0)
  })

  it('records the runtime concurrency rejection as busy, preserving the existing HTTP 429 contract', async () => {
    const gate = deferred()
    const started = deferred()
    let count = 0
    const { call } = fixture({ queries: { summary: async () => {
      if (++count === 4) started.resolve()
      await gate.promise
      return 'ready'
    } } })
    const active = Array.from({ length: 4 }, () => call('/plugins/demo/api/summary'))
    try {
      await started.promise
      const busy = (await call('/plugins/demo/api/summary')).res
      expect(busy.status).toBe(429)
      expect(JSON.parse(busy.body)).toEqual({ ok: false, code: 'busy', error: '插件只读查询繁忙，请稍后重试' })
      flushLogs()
      const rows = readdirSync(process.env.MICA_LOG_DIR).filter((file) => file.startsWith('plugin-operation-'))
        .flatMap((file) => readFileSync(join(process.env.MICA_LOG_DIR, file), 'utf8').trim().split('\n').map((line) => JSON.parse(line)))
      const finish = rows.filter((row) => row.operation === 'web.read.summary' && row.event === 'operation.finish')
      expect(finish).toHaveLength(1)
      expect(finish[0]).toMatchObject({ outcome: 'busy', code: 'busy', pluginVersion: '1.0.0', pid: process.pid, generation: expect.any(String) })
    } finally {
      gate.resolve()
      await Promise.all(active)
    }
  })

  it('cancels outstanding HTTP waits on runtime close and refuses disabled endpoints before load', async () => {
    const gate = deferred()
    const started = deferred()
    const { runtime, call, disabled, loads } = fixture({ loader: async () => {
      started.resolve(); await gate.promise
      return { default: () => ({ queries: {} }) }
    } })
    disabled.add('demo')
    expect((await call('/plugins/demo/api/summary')).res.status).toBe(404)
    expect(loads()).toBe(0)
    disabled.clear()
    const pending = call('/plugins/demo/api/summary')
    await started.promise
    await runtime.close()
    expect((await pending).res.status).toBe(499)
    gate.resolve()
  })

  it('wires lazy modules, common state/close and the route behind remoteGate, with no invoke alias', () => {
    const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    const handler = source.slice(source.indexOf('function createRequestHandler('))
    expect(handler.indexOf('remoteGate(req, pathname)')).toBeLessThan(handler.indexOf('pluginWebRoute(req, res, pathname)'))
    expect(handler.indexOf('pluginWebRoute(req, res, pathname)')).toBeLessThan(handler.indexOf('serveStatic(req, res'))
    expect(source).toContain("import.meta.glob('../../../../plugins/*/web.ts')")
    expect(source).toContain('pluginWebRuntime.sync()')
    expect(source).toContain('pluginWebRuntime.close()')
    expect(source).not.toContain('plugin-host:web-read')
    const vite = readFileSync(new URL('../../electron.vite.config.mjs', import.meta.url), 'utf8')
    expect(vite).toContain("'^/plugins/[a-z0-9][a-z0-9._-]*/api(?:/|$)'")
    expect(vite).not.toContain("'/plugins':")
  })
})
