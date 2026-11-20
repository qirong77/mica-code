import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushLogs } from '@packages/mica-diagnostics/index.js'
import { PluginApiError } from '@packages/mica-plugin/PluginApi.js'
import { createPluginApiRuntime } from '../host/plugin-api-runtime.js'
import { createPluginApiRoute } from './plugin-api-route.js'

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
  const dir = mkdtempSync(join(tmpdir(), 'mica-plugin-api-route-'))
  directories.push(dir)
  return dir
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

/** 读 body 走 `for await`，所以假请求得是 Readable（或带 asyncIterator 的对象）。 */
function request(url, options = {}) {
  const stream = new Readable({ read() {} })
  if (options.body !== undefined) stream.push(Buffer.from(options.body))
  stream.push(null)
  return Object.assign(stream, {
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

function echoHandler() {
  return {
    endpoints: [{ method: 'GET', path: '/notes/:id', summary: '读一条笔记', returns: '{ note }' }],
    handle: ({ method, path, query, body }) => ({
      body: { method, path, query, body: body === undefined ? null : body }
    })
  }
}

function fixture({ create, maxPluginConcurrent, timeoutMs, ...routeOptions } = {}) {
  const home = tempDir()
  const disabled = new Set()
  const manifests = [{ id: 'demo', name: 'Demo', version: '1.0.0', api: true }]
  let loads = 0
  const runtime = createPluginApiRuntime({
    manifests,
    home,
    readDisabled: () => disabled,
    ...(maxPluginConcurrent === undefined ? {} : { maxPluginConcurrent }),
    loaders: new Map([['demo', async () => { loads += 1; return { default: create ?? echoHandler } }]])
  })
  runtimes.push(runtime)
  const route = createPluginApiRoute({
    runtime,
    verifyOrigin: () => ({ ok: true }),
    timeoutMs,
    ...routeOptions
  })
  const call = async (url, options = {}) => {
    const req = request(url, options)
    const res = response()
    const handled = await route(req, res, url.split('?')[0])
    return { req, res, handled, json: () => JSON.parse(res.body) }
  }
  return { route, runtime, disabled, call, loads: () => loads }
}

function operationRows() {
  flushLogs()
  return readdirSync(process.env.MICA_LOG_DIR)
    .filter((file) => file.startsWith('plugin-operation-'))
    .flatMap((file) => readFileSync(join(process.env.MICA_LOG_DIR, file), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function finishes(operation) {
  return operationRows().filter((row) => row.operation === operation && row.event === 'operation.finish')
}

describe('application /plugin namespace: machine-readable plugin API', () => {
  it('serves the endpoint document at the bare /api path without calling the handler', async () => {
    const { call, loads } = fixture({
      create: () => ({
        description: '笔记接口',
        guide: '删除前先确认版本',
        ...echoHandler(),
        handle: () => { throw new Error('must not be called') }
      })
    })
    const { res, json } = await call('/plugin/demo/api')
    expect(res.status).toBe(200)
    expect(json()).toEqual({
      ok: true,
      data: {
        plugin: { id: 'demo', name: 'Demo', version: '1.0.0' },
        base: '/plugin/demo/api',
        description: '笔记接口',
        guide: '删除前先确认版本',
        endpoints: [
          { method: 'GET', path: '/notes/:id', summary: '读一条笔记', returns: '{ note }' },
          { method: 'GET', path: '/api', summary: '接口文档（本响应）', returns: '{ plugin, base, description, guide, endpoints }' }
        ]
      }
    })
    expect(loads()).toBe(1)
    // HEAD 只回头部：content-length 是 GET 会返回的长度，正文为空。
    const head = await call('/plugin/demo/api', { method: 'HEAD' })
    expect(head.res.status).toBe(200)
    expect(head.res.body).toBe('')
    expect(Number(head.res.headers['content-length'])).toBeGreaterThan(0)
    // 根路径是宿主的文档端点，别的方法一律不转发给插件。
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const answer = await call('/plugin/demo/api', { method })
      expect(answer.res.status).toBe(405)
      expect(answer.res.headers.allow).toBe('GET, HEAD')
    }
  })

  it('dispatches method, decoded segments, first-wins query and parsed JSON body', async () => {
    const { call } = fixture()
    const read = await call('/plugin/demo/api/notes/42?sample=PRIVATE_INPUT&sample=second')
    expect(read.res.status).toBe(200)
    expect(read.json()).toEqual({
      ok: true,
      data: { method: 'GET', path: ['notes', '42'], query: { sample: 'PRIVATE_INPUT' }, body: null }
    })
    const written = await call('/plugin/demo/api/notes/42', {
      method: 'POST',
      headers: { host: '127.0.0.1:8787', 'content-type': 'application/json' },
      body: JSON.stringify({ title: '笔记', tags: ['a'] })
    })
    expect(written.res.status).toBe(200)
    expect(written.json().data).toEqual({
      method: 'POST',
      path: ['notes', '42'],
      query: {},
      body: { title: '笔记', tags: ['a'] }
    })
    // PATCH/PUT 也能不带正文：空 body 读成 undefined，宿主按 null 回。
    const empty = await call('/plugin/demo/api/notes/42', { method: 'PUT' })
    expect(empty.json().data.body).toBeNull()
    // 记账只有固定投影：路径与正文都不进 operation 名与日志。
    const success = finishes('api.request')
    expect(success).toContainEqual(expect.objectContaining({ outcome: 'success', code: 'request_complete', surface: 'api' }))
    expect(JSON.stringify(success)).not.toContain('PRIVATE_INPUT')
  })

  it('honors the status a handler asks for and never claims a path outside /plugin', async () => {
    const { call, route } = fixture({
      create: () => ({ ...echoHandler(), handle: () => ({ status: 201, body: { created: true } }) })
    })
    const created = await call('/plugin/demo/api/notes', { method: 'POST', body: '{}' })
    expect(created.res.status).toBe(201)
    expect(created.json()).toEqual({ ok: true, data: { created: true } })
    // `/plugins`（复数）是只读查询与插件页面，机读接口不接管。
    for (const path of ['/plugins/demo/api/summary', '/api/invoke', '/plugin/demo', '/plugin']) {
      expect(await route(request(path), response(), path)).toBe(false)
    }
  })

  it('rejects unknown or disabled plugins before any module is loaded', async () => {
    const { call, disabled, loads } = fixture()
    expect((await call('/plugin/missing/api/notes/1')).res.status).toBe(404)
    expect((await call('/plugin/missing/api')).res.status).toBe(404)
    disabled.add('demo')
    const filtered = await call('/plugin/demo/api/notes/1')
    expect(filtered.res.status).toBe(404)
    expect(filtered.json()).toEqual({ ok: false, code: 'unavailable', error: '插件已停用或没有这个接口' })
    expect(loads()).toBe(0)
  })

  it('only accepts GET/HEAD/POST/PATCH/PUT/DELETE before loading the module', async () => {
    const { call, loads } = fixture()
    for (const method of ['OPTIONS', 'TRACE', 'CONNECT']) {
      const { res } = await call('/plugin/demo/api/notes/1', { method })
      expect(res.status).toBe(405)
      expect(res.headers.allow).toBe('GET, POST, PATCH, PUT, DELETE, HEAD')
    }
    expect(loads()).toBe(0)
  })

  it('rejects malformed paths, oversized queries and bodies before loading the module', async () => {
    const { call, loads } = fixture({ maxBodyBytes: 32 })
    for (const path of ['/plugin/demo/api//notes', '/plugin/demo/api/%2e%2e', '/plugin/demo/api/notes%2F1', `/plugin/demo/api/${'x'.repeat(129)}`]) {
      const { res, json } = await call(path)
      expect(res.status).toBe(400)
      expect(json().code).toBe('invalid_path')
    }
    const tooMany = new URLSearchParams(Array.from({ length: 17 }, (_, index) => [`p${index}`, 'x'])).toString()
    for (const search of [tooMany, `key=${'x'.repeat(2049)}`, `${'x'.repeat(65)}=1`]) {
      const { res, json } = await call(`/plugin/demo/api/notes/1?${search}`)
      expect(res.status).toBe(400)
      expect(json().code).toBe('invalid_params')
    }
    // GET / DELETE 没有 body 的位置：带了就是拼错了。
    for (const method of ['GET', 'DELETE']) {
      const { res, json } = await call('/plugin/demo/api/notes/1', {
        method,
        headers: { host: '127.0.0.1:8787', 'content-length': '2' },
        body: '{}'
      })
      expect(res.status).toBe(400)
      expect(json().code).toBe('invalid_body')
    }
    expect(loads()).toBe(0)
    const invalidJson = await call('/plugin/demo/api/notes/1', { method: 'POST', body: '{not json' })
    expect(invalidJson.res.status).toBe(400)
    expect(invalidJson.json().code).toBe('invalid_json')
    const tooLarge = await call('/plugin/demo/api/notes/1', {
      method: 'POST',
      body: JSON.stringify({ title: 'x'.repeat(64) })
    })
    expect(tooLarge.res.status).toBe(413)
    expect(tooLarge.json().code).toBe('body_too_large')
  })

  it('caps the serialized envelope instead of sending a truncated response', async () => {
    const { call } = fixture({
      maxResponseBytes: 96,
      create: () => ({ ...echoHandler(), handle: () => ({ body: 'x'.repeat(256) }) })
    })
    const { res } = await call('/plugin/demo/api/notes/1')
    expect(res.status).toBe(413)
    expect(res.body).toBe(JSON.stringify({ ok: false, code: 'response_too_large', error: '插件接口响应超过大小上限' }))
  })

  it('passes a plugin-declared error through and normalizes internal failures', async () => {
    const behavior = { kind: 'plugin' }
    const { call } = fixture({
      create: () => ({
        ...echoHandler(),
        handle: () => {
          if (behavior.kind === 'internal') throw new Error('INTERNAL_STACK_OR_SECRET')
          throw new PluginApiError(409, 'note_conflict', '笔记已被改动')
        }
      })
    })
    const conflict = await call('/plugin/demo/api/notes/1', { method: 'POST', body: '{}' })
    expect(conflict.res.status).toBe(409)
    expect(conflict.json()).toEqual({ ok: false, code: 'note_conflict', error: '笔记已被改动' })

    behavior.kind = 'internal'
    const internal = await call('/plugin/demo/api/notes/1')
    expect(internal.res.status).toBe(500)
    expect(internal.res.body).not.toContain('INTERNAL_STACK_OR_SECRET')
    expect(internal.json()).toEqual({ ok: false, code: 'request_failed', error: '插件接口调用失败，请稍后重试' })
  })

  it('cancels a hanging handler through the request timer without leaking its promise', async () => {
    let signal
    const { call } = fixture({
      timeoutMs: 50,
      create: () => ({
        ...echoHandler(),
        handle: (request) => {
          signal = request.signal
          return new Promise(() => {})
        }
      })
    })
    const { res, json } = await call('/plugin/demo/api/notes/1')
    expect(res.status).toBe(504)
    expect(json().code).toBe('timeout')
    expect(signal.aborted).toBe(true)
    expect(signal.reason.name).toBe('TimeoutError')
  })

  it('records the concurrency rejection as busy and keeps the existing 429 contract', async () => {
    const gate = deferred()
    const started = deferred()
    const { call } = fixture({
      maxPluginConcurrent: 1,
      create: () => ({
        ...echoHandler(),
        handle: () => {
          started.resolve()
          return gate.promise.then(() => ({ body: null }))
        }
      })
    })
    const held = call('/plugin/demo/api/notes/1')
    await started.promise
    const busy = await call('/plugin/demo/api/notes/1')
    gate.resolve()
    await held
    expect(busy.res.status).toBe(429)
    expect(busy.json()).toEqual({ ok: false, code: 'busy', error: '插件接口繁忙，请稍后重试' })
    expect(finishes('api.request')).toContainEqual(
      expect.objectContaining({ outcome: 'busy', code: 'busy', surface: 'api', pluginVersion: '1.0.0' })
    )
  })

  it('applies the real Host/Origin guard before touching any plugin', async () => {
    let loads = 0
    const runtime = createPluginApiRuntime({
      manifests: [{ id: 'demo', name: 'Demo', version: '1.0.0', api: true }],
      home: tempDir(),
      loaders: new Map([['demo', async () => { loads += 1; return { default: echoHandler } }]])
    })
    runtimes.push(runtime)
    const route = createPluginApiRoute({ runtime, verifyOrigin: verifyRequestOrigin })
    for (const headers of [
      { host: 'not-this-host.invalid:8787' },
      { host: '127.0.0.1:8787', origin: 'https://not-this-host.invalid' },
      { host: '127.0.0.1:8787', origin: 'null' }
    ]) {
      for (const path of ['/plugin/demo/api', '/plugin/demo/api/notes/1']) {
        const res = response()
        expect(await route(request(path, { headers }), res, path)).toBe(true)
        expect(res.status).toBe(403)
      }
    }
    expect(loads).toBe(0)
    const res = response()
    expect(
      await route(
        request('/plugin/demo/api/notes/1', { headers: { host: '127.0.0.1:8787', origin: 'http://localhost:5173' } }),
        res,
        '/plugin/demo/api/notes/1'
      )
    ).toBe(true)
    expect(res.status).toBe(200)
    expect(loads).toBe(1)
  })

  it('wires the runtime and dispatches /plugin/<id>/api before the MCP route', () => {
    const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
    const handler = source.slice(source.indexOf('function createRequestHandler('))
    // MCP 路由吃掉整个 `/plugin/*` 命名空间：机读接口必须在它之前分派。
    expect(handler.indexOf('pluginApiRoute(req, res, pathname)')).toBeLessThan(
      handler.indexOf('pluginMcpRoute(req, res, pathname)')
    )
    expect(handler.indexOf('remoteGate(req, pathname)')).toBeLessThan(
      handler.indexOf('pluginApiRoute(req, res, pathname)')
    )
    expect(handler.indexOf('pluginApiRoute(req, res, pathname)')).toBeLessThan(
      handler.indexOf('pluginWebRoute(req, res, pathname)')
    )
    expect(source).toContain("import.meta.glob('../../../../plugins/*/api.ts')")
    expect(source).toContain('pluginApiRuntime.sync()')
    expect(source).toContain('pluginApiRuntime.close()')
  })
})
