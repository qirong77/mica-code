import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { createServer, request } from 'node:http'
import { createConnection } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAttachmentUploads, UPLOAD_CHUNK_SIZE } from './attachment-uploads.js'
import { uploadAttachment } from '../renderer/src/attachment-upload.js'

let testRoot
let originalHome
const fixtures = []

beforeEach(() => {
  originalHome = process.env.MICA_HOME
  testRoot = mkdtempSync(join(tmpdir(), 'mica-attachment-uploads-test-'))
  process.env.MICA_HOME = join(testRoot, 'home')
})

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close()
  if (originalHome === undefined) delete process.env.MICA_HOME
  else process.env.MICA_HOME = originalHome
  rmSync(testRoot, { recursive: true, force: true })
})

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text)
  })
  res.end(text)
}

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${server.address().port}`
}

function startRequest(
  base,
  path,
  { method = 'GET', body, headers = {}, partial = false, chunked = false } = {}
) {
  if (body !== undefined && !Buffer.isBuffer(body)) body = Buffer.from(body)
  if (body !== undefined && !chunked && !Object.hasOwn(headers, 'content-length')) {
    headers = { ...headers, 'content-length': body.length }
  }
  let req
  const answer = new Promise((resolve, reject) => {
    req = request(new URL(path, base), { method, headers, agent: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('error', reject)
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode, text, json: text ? JSON.parse(text) : null })
      })
    })
    req.on('error', reject)
    if (partial) {
      if (body) req.write(body)
      else req.flushHeaders()
    } else req.end(body)
  })
  return { req, answer }
}

async function fixture({ proxy = false, ...dependencies } = {}) {
  const stagingParent = mkdtempSync(join(testRoot, 'staging-'))
  let clock = 0
  let sweep
  let timerCleared = false
  const timer = { unref() {} }
  const uploads = createAttachmentUploads({
    sendJson,
    tempDir: stagingParent,
    now: () => clock,
    setInterval: (callback) => {
      sweep = callback
      return timer
    },
    clearInterval: (value) => {
      expect(value).toBe(timer)
      timerCleared = true
    },
    ...dependencies
  })
  const waiters = new Map()
  const server = createServer(async (req, res) => {
    const waiter = waiters.get(req.url)
    waiters.delete(req.url)
    waiter?.resolve(req)
    try {
      if (!(await uploads.handle(req, res, new URL(req.url, 'http://localhost')))) {
        sendJson(res, 404, { ok: false, code: 'outside_uploads' })
      }
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error) })
    }
  })
  const upstream = await listen(server)
  let proxyServer
  let base = upstream
  if (proxy) {
    // 真实 HTTP 中间层：完整请求体不得超过 nginx 默认的 1 MiB。
    proxyServer = createServer((req, res) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size <= 1024 * 1024) chunks.push(chunk)
      })
      req.on('end', () => {
        if (size > 1024 * 1024) return sendJson(res, 413, { ok: false, code: 'proxy_body_limit' })
        const forwarded = request(
          new URL(req.url, upstream),
          {
            method: req.method,
            headers: { ...req.headers, 'content-length': size }
          },
          (reply) => {
            res.writeHead(reply.statusCode, reply.headers)
            reply.pipe(res)
          }
        )
        forwarded.on('error', () => sendJson(res, 502, { ok: false }))
        forwarded.end(Buffer.concat(chunks, size))
      })
    })
    base = await listen(proxyServer)
  }
  const call = (path, options) => startRequest(base, path, options).answer
  const result = {
    uploads,
    call,
    base,
    upstream,
    stagingParent,
    root: join(stagingParent, readdirSync(stagingParent)[0]),
    sweep: () => sweep(),
    advance: (ms) => {
      clock += ms
    },
    timerCleared: () => timerCleared,
    waitForRequest: (path) => {
      const waiter = deferred()
      waiters.set(path, waiter)
      return waiter.promise
    },
    create: (metadata = {}) =>
      call('/api/uploads', {
        method: 'POST',
        body: JSON.stringify({
          name: 'report.bin',
          type: 'application/octet-stream',
          size: 1,
          kind: 'attachment',
          ...metadata
        })
      }),
    close: async () => {
      await uploads.dispose()
      for (const listener of [proxyServer, server].filter(Boolean)) {
        listener.closeAllConnections()
        await new Promise((resolve) => listener.close(resolve))
      }
    }
  }
  fixtures.push(result)
  return result
}

const pathFor = (id) => `/api/uploads/${id}`
const chunkPath = (id, offset = 0) => `${pathFor(id)}?offset=${offset}`
const completePath = (id) => `${pathFor(id)}/complete`

describe('binary attachment upload HTTP protocol', () => {
  it('uploads a large photo using the real browser upload helper through the limiting proxy', async () => {
    const f = await fixture({ proxy: true })
    const bytes = randomBytes(3 * 1024 * 1024 + 173)
    bytes.set([255, 216, 255], 0)
    const file = new File([bytes], 'phone-photo.jpg', { type: 'image/jpeg' })
    const originalFetch = globalThis.fetch
    const progress = []
    globalThis.fetch = (path, options) => originalFetch(new URL(path, f.base), options)
    try {
      const saved = await uploadAttachment(file, {
        kind: 'image',
        onProgress: (value) => progress.push(value)
      })
      expect(saved.ok).toBe(true)
      expect(saved.ref.endsWith('.jpg')).toBe(true)
      expect(readFileSync(saved.ref)).toEqual(bytes)
      expect(progress.at(-1)).toEqual({ loaded: file.size, total: file.size, phase: 'done' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reassembles a multi-MiB file through a real 1 MiB proxy with three out-of-order workers', async () => {
    const f = await fixture({ proxy: true })
    const bytes = randomBytes(3 * 1024 * 1024 + 173)
    const oversized = await f.call('/api/uploads', { method: 'POST', body: bytes })
    expect(oversized.status).toBe(413)
    expect(oversized.json.code).toBe('proxy_body_limit')
    const created = await f.create({ size: bytes.length, name: '../photo.bin' })
    expect(created.status).toBe(200)
    expect(created.json).toEqual({ ok: true, id: expect.any(String), chunkSize: 524288 })
    const { id, chunkSize } = created.json
    const offsets = Array.from(
      { length: Math.ceil(bytes.length / chunkSize) },
      (_, index) => index * chunkSize
    ).reverse()
    for (let index = 0; index < offsets.length; index += 3) {
      const replies = await Promise.all(
        offsets.slice(index, index + 3).map((offset) =>
          f.call(chunkPath(id, offset), {
            method: 'PUT',
            body: bytes.subarray(offset, offset + chunkSize)
          })
        )
      )
      expect(replies.map((reply) => reply.status)).toEqual(replies.map(() => 200))
    }
    const saved = await f.call(completePath(id), { method: 'POST' })
    expect(saved.status).toBe(200)
    expect(saved.json.name).toBe('photo.bin')
    expect(readFileSync(saved.json.path).equals(bytes)).toBe(true)
    expect(readdirSync(f.root)).toEqual([])
    expect((await f.call(pathFor(id), { method: 'DELETE' })).status).toBe(200)
    expect(readFileSync(saved.json.path).equals(bytes)).toBe(true)
  })

  it('makes identical concurrent chunks and concurrent completion idempotent, and rejects changed duplicates', async () => {
    const f = await fixture()
    const bytes = randomBytes(UPLOAD_CHUNK_SIZE)
    const { id } = (await f.create({ size: bytes.length })).json
    const duplicates = await Promise.all(
      Array.from({ length: 3 }, () => f.call(chunkPath(id), { method: 'PUT', body: bytes }))
    )
    expect(duplicates.map((reply) => reply.status)).toEqual([200, 200, 200])
    const conflict = await f.call(chunkPath(id), {
      method: 'PUT',
      body: Buffer.alloc(bytes.length)
    })
    expect(conflict.status).toBe(409)
    expect(conflict.json.code).toBe('chunk_conflict')
    const completed = await Promise.all(
      Array.from({ length: 3 }, () => f.call(completePath(id), { method: 'POST' }))
    )
    expect(completed.map((reply) => reply.status)).toEqual([200, 200, 200])
    expect(completed[1].json).toEqual(completed[0].json)
    expect(completed[2].json).toEqual(completed[0].json)
    expect((await f.call(completePath(id), { method: 'POST' })).json).toEqual(completed[0].json)
    expect(readdirSync(join(process.env.MICA_HOME, 'attachments'))).toHaveLength(1)
    expect(readFileSync(completed[0].json.path).equals(bytes)).toBe(true)
    expect((await f.call(chunkPath(id), { method: 'PUT', body: bytes })).status).toBe(409)
  })

  it('bounds metadata, rejects empty/invalid/oversized files, and reserves at most eight sessions atomically', async () => {
    const f = await fixture()
    for (const metadata of [
      { size: 0 },
      { size: -1 },
      { size: 1.5 },
      { size: '1' },
      { name: '' },
      { kind: 'other' }
    ]) {
      expect((await f.create(metadata)).status).toBe(400)
    }
    expect((await f.create({ size: 64 * 1024 * 1024 + 1 })).json.code).toBe('file_too_large')
    expect((await f.call('/api/uploads', { method: 'POST', body: '{' })).json.code).toBe(
      'invalid_json'
    )
    for (const chunked of [false, true]) {
      const oversized = await f.call('/api/uploads', {
        method: 'POST',
        body: 'x'.repeat(8193),
        chunked
      })
      expect(oversized.status).toBe(413)
      expect(oversized.json.code).toBe('body_too_large')
    }
    const max = await f.create({ size: 64 * 1024 * 1024 })
    expect(max.status).toBe(200)
    await f.call(pathFor(max.json.id), { method: 'DELETE' })
    const created = await Promise.all(Array.from({ length: 9 }, () => f.create()))
    expect(created.filter((reply) => reply.status === 200)).toHaveLength(8)
    expect(created.filter((reply) => reply.status === 429)).toHaveLength(1)
    expect(readdirSync(f.root)).toHaveLength(8)
    for (const reply of created.filter((reply) => reply.status === 200)) {
      await f.call(pathFor(reply.json.id), { method: 'DELETE' })
    }
    expect(readdirSync(f.root)).toEqual([])
    expect((await f.create()).status).toBe(200)
  })

  it('validates offset, exact block sizes, bounded complete bodies, and missing chunks before saving', async () => {
    const f = await fixture()
    const { id } = (await f.create({ size: UPLOAD_CHUNK_SIZE + 2 })).json
    for (const query of [
      '',
      '?offset=-1',
      '?offset=1',
      '?offset=0.5',
      '?offset=00',
      '?offset=9007199254740992',
      `?offset=${2 * UPLOAD_CHUNK_SIZE}`,
      '?offset=0&offset=0'
    ]) {
      expect((await f.call(`${pathFor(id)}${query}`, { method: 'PUT', body: 'a' })).json.code).toBe(
        'invalid_offset'
      )
    }
    const short = await f.call(chunkPath(id), { method: 'PUT', body: 'a' })
    expect(short.status).toBe(400)
    expect(short.json.code).toBe('invalid_chunk_size')
    for (const chunked of [false, true]) {
      const oversized = await f.call(chunkPath(id), {
        method: 'PUT',
        body: Buffer.alloc(UPLOAD_CHUNK_SIZE + 1),
        chunked
      })
      expect(oversized.status).toBe(413)
      expect(oversized.json.code).toBe('body_too_large')
    }
    const tail = await f.call(chunkPath(id, UPLOAD_CHUNK_SIZE), { method: 'PUT', body: 'ab' })
    expect(tail.status).toBe(200)
    expect((await f.call(completePath(id), { method: 'POST' })).json.code).toBe('missing_chunks')
    expect(
      (await f.call(completePath(id), { method: 'POST', body: Buffer.alloc(8193), chunked: true }))
        .status
    ).toBe(413)
    expect(() => readdirSync(process.env.MICA_HOME)).toThrow() // no save function was called
    await f.call(chunkPath(id), { method: 'PUT', body: Buffer.alloc(UPLOAD_CHUNK_SIZE) })
    const complete = await f.call(completePath(id), { method: 'POST' })
    expect(complete.status).toBe(200)
    expect(readFileSync(complete.json.path).length).toBe(UPLOAD_CHUNK_SIZE + 2)
  })

  it('uses only known image extensions, detects unknown MIME by magic bytes, and rejects unsupported images', async () => {
    const f = await fixture()
    const examples = [
      {
        type: 'IMAGE/JPEG',
        name: '../../evil.svg',
        bytes: Buffer.from([255, 216, 255, 0]),
        extension: 'jpg'
      },
      {
        type: '',
        name: 'untrusted.ext',
        bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        extension: 'png'
      },
      {
        type: 'application/octet-stream',
        name: 'file.png',
        bytes: Buffer.from('GIF89adata'),
        extension: 'gif'
      },
      { type: '', name: 'x.js', bytes: Buffer.from('RIFFxxxxWEBPdata'), extension: 'webp' }
    ]
    for (const sample of examples) {
      const { id } = (await f.create({ ...sample, size: sample.bytes.length, kind: 'image' })).json
      await f.call(chunkPath(id), { method: 'PUT', body: sample.bytes })
      const completed = await f.call(completePath(id), { method: 'POST' })
      expect(completed.status).toBe(200)
      expect(completed.json.ref.endsWith(`.${sample.extension}`)).toBe(true)
      expect(readFileSync(completed.json.ref).equals(sample.bytes)).toBe(true)
    }
    const { id } = (
      await f.create({ kind: 'image', type: 'image/svg+xml', name: 'x.png', size: 6 })
    ).json
    await f.call(chunkPath(id), { method: 'PUT', body: '<svg/>' })
    expect((await f.call(completePath(id), { method: 'POST' })).json.code).toBe('unsupported_image')
    expect(readdirSync(join(process.env.MICA_HOME, 'images'))).toHaveLength(4)
  })

  it('waits for in-flight PUTs before completing and prevents new writes during commit', async () => {
    const saving = deferred()
    const saved = deferred()
    let calls = 0
    const f = await fixture({
      saveAttachmentBytes: async (bytes) => {
        calls++
        expect(bytes.toString()).toBe('ab')
        saving.resolve()
        await saved.promise
        return { ok: true, path: '/test/saved', name: 'report.bin' }
      }
    })
    const { id } = (await f.create({ size: 2 })).json
    const path = chunkPath(id)
    const arrived = f.waitForRequest(path)
    const partial = startRequest(f.base, path, {
      method: 'PUT',
      body: 'a',
      headers: { 'content-length': 2 },
      partial: true
    })
    await arrived
    const completeArrived = f.waitForRequest(completePath(id))
    const completed = f.call(completePath(id), { method: 'POST' })
    await completeArrived
    partial.req.end('b')
    expect((await partial.answer).status).toBe(200)
    await saving.promise
    expect((await f.call(chunkPath(id), { method: 'PUT', body: 'ab' })).status).toBe(409)
    const again = f.call(completePath(id), { method: 'POST' })
    saved.resolve()
    expect((await completed).json).toEqual((await again).json)
    expect(calls).toBe(1)
  })

  it('cancels a PUT still receiving bytes and removes only its own staging', async () => {
    const f = await fixture()
    const first = (await f.create({ size: 2 })).json.id
    const other = (await f.create()).json.id
    writeFileSync(join(f.stagingParent, 'unrelated'), 'keep')
    mkdirSync(process.env.MICA_HOME)
    writeFileSync(join(process.env.MICA_HOME, 'keep'), 'keep')
    const arrived = f.waitForRequest(chunkPath(first))
    const partial = startRequest(f.base, chunkPath(first), {
      method: 'PUT',
      body: 'a',
      headers: { 'content-length': 2 },
      partial: true
    })
    await arrived
    const cancelled = await f.call(pathFor(first), { method: 'DELETE' })
    expect(cancelled.status).toBe(200)
    expect((await partial.answer).json.code).toBe('upload_cancelled')
    partial.req.end()
    expect(readdirSync(f.root)).toEqual([other])
    expect((await f.call(completePath(first), { method: 'POST' })).status).toBe(404)
    await f.uploads.dispose()
    expect(f.timerCleared()).toBe(true)
    expect(readdirSync(f.stagingParent)).toEqual(['unrelated'])
    expect(readFileSync(join(process.env.MICA_HOME, 'keep'), 'utf8')).toBe('keep')
    expect((await f.create()).status).toBe(503)
  })

  it('cleans abandoned request staging, and skips active IO when sweeping idle sessions', async () => {
    const f = await fixture()
    const idle = (await f.create()).json.id
    const active = (await f.create({ size: 2 })).json.id
    const arrived = f.waitForRequest(chunkPath(active))
    const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(f.base).port) })
    await new Promise((resolve) => socket.once('connect', resolve))
    socket.write(
      `PUT ${chunkPath(active)} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\na`
    )
    const incoming = await arrived
    const closed = new Promise((resolve) => incoming.once('close', resolve))
    f.advance(10 * 60 * 1000)
    await f.sweep()
    expect(readdirSync(f.root)).toEqual([active])
    expect((await f.call(completePath(idle), { method: 'POST' })).status).toBe(404)
    socket.destroy()
    await closed
    // 半块尚未落盘：保留已收齐的其它块，允许客户端在同一上传中重试。
    expect((await f.call(chunkPath(active), { method: 'PUT', body: 'ab' })).status).toBe(200)
    const retried = await f.call(completePath(active), { method: 'POST' })
    expect(retried.status).toBe(200)
    expect(readFileSync(retried.json.path, 'utf8')).toBe('ab')
    await f.uploads.dispose()
    expect(readdirSync(f.stagingParent)).toEqual([])
    expect(f.timerCleared()).toBe(true)
  })

  it('cancels a completion request still receiving its body without waiting indefinitely', async () => {
    const f = await fixture()
    const { id } = (await f.create()).json
    await f.call(chunkPath(id), { method: 'PUT', body: 'a' })
    const arrived = f.waitForRequest(completePath(id))
    const partial = startRequest(f.base, completePath(id), {
      method: 'POST',
      body: '{',
      headers: { 'content-length': 2 },
      partial: true
    })
    await arrived
    expect((await f.call(pathFor(id), { method: 'DELETE' })).status).toBe(200)
    expect((await partial.answer).json.code).toBe('upload_cancelled')
    partial.req.end('}')
    expect(readdirSync(f.root)).toEqual([])
  })

  it('expires completion receipts after ten idle minutes without removing saved files', async () => {
    const f = await fixture()
    const { id } = (await f.create()).json
    await f.call(chunkPath(id), { method: 'PUT', body: 'a' })
    const completed = await f.call(completePath(id), { method: 'POST' })
    f.advance(10 * 60 * 1000 - 1)
    await f.sweep()
    expect((await f.call(completePath(id), { method: 'POST' })).json).toEqual(completed.json)
    f.advance(10 * 60 * 1000)
    await f.sweep()
    expect((await f.call(completePath(id), { method: 'POST' })).status).toBe(404)
    expect(readFileSync(completed.json.path, 'utf8')).toBe('a')
  })

  it('allows more than eight sequential attachments without waiting for completed receipts to expire', async () => {
    const f = await fixture()
    for (let index = 0; index < 10; index += 1) {
      const created = await f.create()
      expect(created.status).toBe(200)
      const { id } = created.json
      expect((await f.call(chunkPath(id), { method: 'PUT', body: 'a' })).status).toBe(200)
      expect((await f.call(completePath(id), { method: 'POST' })).status).toBe(200)
    }
    expect(readdirSync(join(process.env.MICA_HOME, 'attachments'))).toHaveLength(10)
  })

  it('does not consume other API routes and returns clear errors for unsupported upload methods or IDs', async () => {
    const f = await fixture()
    expect((await f.call('/api/invoke')).json.code).toBe('outside_uploads')
    expect((await f.call('/api/uploads-other')).json.code).toBe('outside_uploads')
    expect((await f.call('/api/uploads')).status).toBe(405)
    expect((await f.call('/api/uploads/not-an-id', { method: 'PUT', body: 'a' })).status).toBe(404)
    const { id } = (await f.create()).json
    expect((await f.call(pathFor(id))).status).toBe(405)
    expect((await f.call(completePath(id), { method: 'DELETE' })).status).toBe(405)
  })
})
