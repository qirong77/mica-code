import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { test } from 'bun:test'
import { sendJson } from './json-response.js'

const largeBody = {
  message: '压缩后的响应仍然要保留非 ASCII 文本',
  rows: Array.from({ length: 500 }, (_, index) => ({
    id: index,
    label: '重复内容用于验证 gzip 响应体确实变小'
  }))
}

const smallBody = { ok: true, message: '小响应' }

async function withServer(handler, run) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    return await run(port)
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
}

function get(port, path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers, method }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('compresses large JSON, preserves UTF-8, and reports the compressed length', async () => {
  await withServer(
    (req, res) => {
      res.setHeader('x-before-send', 'kept')
      res.setHeader('vary', 'Origin')
      void sendJson(res, 200, largeBody)
    },
    async (port) => {
      const { res, body } = await get(port, '/', { 'accept-encoding': 'GZip, br' })
      assert.equal(res.statusCode, 200)
      assert.equal(res.headers['content-encoding'], 'gzip')
      assert.equal(Number(res.headers['content-length']), body.byteLength)
      assert.equal(res.headers['content-type'], 'application/json;charset=utf-8')
      assert.equal(res.headers['cache-control'], 'no-store')
      assert.match(res.headers.vary, /Origin/)
      assert.match(res.headers.vary, /Accept-Encoding/i)
      assert.equal(res.headers['x-before-send'], 'kept')
      assert.deepEqual(JSON.parse(gunzipSync(body).toString('utf8')), largeBody)
    }
  )
})

test('keeps small and unacceptable responses uncompressed', async () => {
  await withServer(
    (req, res) => {
      void sendJson(
        res,
        req.url === '/small' ? 201 : 200,
        req.url === '/small' ? smallBody : largeBody
      )
    },
    async (port) => {
      const small = await get(port, '/small', { 'accept-encoding': 'gzip' })
      assert.equal(small.res.statusCode, 201)
      assert.equal(small.res.headers['content-encoding'], undefined)
      assert.equal(Number(small.res.headers['content-length']), small.body.byteLength)
      assert.deepEqual(JSON.parse(small.body.toString('utf8')), smallBody)

      for (const encoding of ['gzip;q=0', '*;q=0', 'identity', 'xgzip', 'gzip;q=0, *;q=1']) {
        const result = await get(port, '/', { 'accept-encoding': encoding })
        assert.equal(result.res.headers['content-encoding'], undefined, encoding)
        assert.equal(Number(result.res.headers['content-length']), result.body.byteLength, encoding)
        assert.deepEqual(JSON.parse(result.body.toString('utf8')), largeBody)
      }
    }
  )
})

test('uses explicit gzip over wildcard negotiation and accepts wildcard gzip', async () => {
  await withServer(
    (req, res) => {
      void sendJson(res, 200, largeBody)
    },
    async (port) => {
      const explicit = await get(port, '/', { 'accept-encoding': '*;q=0, gzip;q=1' })
      assert.equal(explicit.res.headers['content-encoding'], 'gzip')

      const wildcard = await get(port, '/', { 'accept-encoding': '*;q=1' })
      assert.equal(wildcard.res.headers['content-encoding'], 'gzip')
      assert.deepEqual(JSON.parse(gunzipSync(wildcard.body).toString('utf8')), largeBody)
    }
  )
})

test('preserves a wildcard Vary, clears stale encoding, and sends only headers for HEAD', async () => {
  await withServer(
    (req, res) => {
      res.setHeader('vary', '*')
      res.setHeader('content-encoding', 'gzip')
      res.setHeader('access-control-allow-origin', 'https://example.test')
      void sendJson(res, 200, largeBody)
    },
    async (port) => {
      const plain = await get(port, '/')
      assert.equal(plain.res.headers['content-encoding'], undefined)
      assert.equal(plain.res.headers.vary, '*')
      assert.equal(plain.res.headers['access-control-allow-origin'], 'https://example.test')
      const head = await get(port, '/', { 'accept-encoding': 'gzip' }, 'HEAD')
      assert.equal(head.body.length, 0)
      assert.equal(head.res.headers['content-encoding'], 'gzip')
      assert.ok(Number(head.res.headers['content-length']) > 0)
    }
  )
})
