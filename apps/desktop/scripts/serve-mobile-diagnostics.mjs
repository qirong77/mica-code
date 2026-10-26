import { access, appendFile, readFile, stat } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preview } from 'vite'
import {
  DEFAULT_RUNTIME_PORT,
  RUNTIME_PORT_ENV,
  loopbackRuntimeUrl,
  parseRuntimePort
} from '../../../packages/mica-web-shared/runtime-port.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out/renderer')
const version = 'keyboard-3'
// 诊断代理自己也要一个端口：默认错开运行时一万（8787 → 18787），运行时换了端口它跟着换，
// 不跟运行时抢；真要换用 MICA_DIAGNOSTICS_PORT。
const port = parseRuntimePort(process.env.MICA_DIAGNOSTICS_PORT, DEFAULT_RUNTIME_PORT + 10000)
// 显式给了 MICA_DESKTOP_PORT 就必须是合法端口：悄悄落回 8787 会去探另一台运行时，
// 那正是这个脚本要排查的错觉。
const upstreamPort = process.env[RUNTIME_PORT_ENV]
  ? parseRuntimePort(process.env[RUNTIME_PORT_ENV], 0)
  : DEFAULT_RUNTIME_PORT
const maxBodyBytes = 256 * 1024
const maxLogBytes = 20 * 1024 * 1024
const logPath = join(tmpdir(), `mica-mobile-viewport-${process.pid}.ndjson`)
let logBytes = 0
let writes = Promise.resolve()
let server

function reply(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(JSON.stringify(value))
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0
    const chunks = []
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onAborted)
    }
    const fail = (error) => {
      cleanup()
      req.resume()
      reject(error)
    }
    const onData = (chunk) => {
      size += chunk.length
      if (size > maxBodyBytes) {
        fail(Object.assign(new Error('Body too large'), { status: 413 }))
      } else {
        chunks.push(chunk)
      }
    }
    const onEnd = () => {
      cleanup()
      resolveBody(Buffer.concat(chunks).toString('utf8'))
    }
    const onError = () => fail(new Error('Request failed'))
    const onAborted = () => fail(new Error('Request aborted'))
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
    req.on('aborted', onAborted)
  })
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

async function diagnostics(req, res, next) {
  if (req.method === 'GET' && req.url?.split('?')[0] === '/manifest.webmanifest') {
    // 截图来自主屏幕模式时，复现也必须用同样的容器。默认 manifest 的 start_url
    // 会丢失调试参数，专用服务保留开关，正式应用的 manifest 不受影响。
    const manifest = JSON.parse(await readFile(join(outDir, 'manifest.webmanifest'), 'utf8'))
    res.writeHead(200, {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'no-store'
    })
    return res.end(
      JSON.stringify({
        ...manifest,
        name: 'Mica 键盘诊断',
        short_name: 'Mica 诊断',
        start_url: '/?viewport-debug=1'
      })
    )
  }
  if (req.url?.split('?')[0] !== '/__viewport-debug') return next()
  if (req.method === 'GET') return reply(res, 200, { ok: true, version })
  if (req.method !== 'POST') return reply(res, 405, { ok: false })
  if (!req.headers.origin || req.headers.origin !== `http://${req.headers.host}`) {
    return reply(res, 403, { ok: false })
  }
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return reply(res, 415, { ok: false })
  }
  if (Number(req.headers['content-length']) > maxBodyBytes) {
    req.resume()
    return reply(res, 413, { ok: false })
  }

  let payload
  try {
    payload = JSON.parse(await readBody(req))
  } catch (error) {
    return reply(res, error.status || 400, { ok: false })
  }
  if (
    !isObject(payload) ||
    payload.version !== version ||
    typeof payload.pageId !== 'string' ||
    payload.pageId.length === 0 ||
    payload.pageId.length > 128 ||
    !isObject(payload.environment) ||
    !Array.isArray(payload.samples) ||
    payload.samples.length > 12 ||
    !payload.samples.every(isObject)
  ) {
    return reply(res, 400, { ok: false })
  }

  // Only the frontend's layout diagnostics envelope is persisted. Never log
  // proxy traffic, request bodies on errors, or runtime/chat data.
  const line = `${JSON.stringify({
    version,
    pageId: payload.pageId,
    environment: payload.environment,
    samples: payload.samples
  })}\n`
  const bytes = Buffer.byteLength(line)
  const write = writes.then(async () => {
    if (logBytes + bytes > maxLogBytes) return false
    // Reserve the bytes even if an append partially fails.
    logBytes += bytes
    await appendFile(logPath, line, { mode: 0o600 })
    return true
  })
  writes = write.catch(() => {})
  try {
    if (!(await write)) return reply(res, 503, { ok: false })
  } catch {
    return reply(res, 503, { ok: false })
  }
  console.log(
    `Received ${payload.samples.length} samples; UA=${JSON.stringify((req.headers['user-agent'] || '').slice(0, 1024))}`
  )
  reply(res, 200, { ok: true })
}

async function main() {
  if (!upstreamPort) throw new Error(`${RUNTIME_PORT_ENV} must be a valid port`)
  await access(join(outDir, 'index.html'))
  const target = loopbackRuntimeUrl(upstreamPort)
  const health = await fetch(`${target}/api/health`, {
    signal: AbortSignal.timeout(5000),
    redirect: 'error'
  })
  if (!health.ok || (await health.json()).app !== 'mica-code-app') {
    throw new Error(`Upstream is not a healthy Mica runtime (HTTP ${health.status})`)
  }
  logBytes = await stat(logPath).then(
    (info) => info.size,
    (error) => {
      if (error.code === 'ENOENT') return 0
      throw error
    }
  )
  server = await preview({
    configFile: false,
    root,
    build: { outDir },
    plugins: [
      {
        name: 'mobile-viewport-diagnostics',
        configurePreviewServer(app) {
          app.middlewares.use((req, res, next) => {
            diagnostics(req, res, next).catch(() => {
              if (!res.headersSent) reply(res, 500, { ok: false })
              else res.destroy()
            })
          })
        }
      }
    ],
    preview: {
      host: '0.0.0.0',
      port,
      strictPort: true,
      cors: false,
      headers: { 'Cache-Control': 'no-store' },
      proxy: {
        '/api': { target, changeOrigin: false, ws: true },
        '/remote/control': { target, changeOrigin: false, ws: true }
      }
    }
  })
  const addresses = new Set(['127.0.0.1'])
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.add(entry.address)
    }
  }
  for (const address of addresses) console.log(`http://${address}:${port}/?viewport-debug=1`)
  console.log(`Viewport log: ${logPath}`)
}

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  const deadline = setTimeout(() => process.exit(1), 5000)
  deadline.unref()
  try {
    await server?.close()
    await writes
    process.exit(0)
  } catch {
    process.exit(1)
  }
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
main().catch((error) => {
  console.error(`Mobile diagnostics failed: ${error.message}`)
  process.exit(1)
})
