/**
 * 系统检查的 HTTP 服务。**只监听一个 Unix socket**（不占 TCP 端口），唯一调用方是运行时
 * （`src/host/system-checks.js`），所以这里既没有 SSE 也没有 CORS 头：挡一次 DNS rebinding
 * 与跨站网页就够了（见 shared/endpoint-http.js）。
 *
 * 路由表由 system-docs.js 的端点目录编译，端点与文档同源。
 */

import { createServer } from 'node:http'
import {
  compileRoutes,
  listenLocalSocket,
  resolveRoute,
  verifyLocalRequest
} from '../shared/endpoint-http.js'
import {
  SYSTEM_SERVICE_APP,
  SYSTEM_SERVICE_VERSION,
  SystemRequestError,
  requireAllowedPane
} from './system-core.js'
import { SYSTEM_ENDPOINTS } from './system-docs.js'

const MAX_BODY_BYTES = 64 * 1024

/**
 * @param probe 读一次系统状态，返回 `buildSystemChecks()` 的形状
 * @param openSettings 真的去打开面板（主进程里是 `shell.openExternal`）
 */
export function createSystemService({ probe, openSettings }) {
  const routes = compileRoutes(SYSTEM_ENDPOINTS)
  const handlers = buildHandlers({ probe, openSettings })

  async function handle(req, res) {
    const guard = verifyLocalRequest(req)
    if (!guard.ok) return sendJson(res, guard.status, { ok: false, error: guard.error })

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    const method = req.method === 'HEAD' ? 'GET' : req.method
    const matched = resolveRoute(routes, method, url.pathname)
    if (!matched) {
      return sendJson(res, 404, { ok: false, error: `未知端点：${method} ${url.pathname}` })
    }

    let body = {}
    if (method !== 'GET') {
      const raw = await readBody(req)
      if (raw.trim()) {
        if (!/^application\/json\b/.test(String(req.headers['content-type'] || ''))) {
          return sendJson(res, 415, {
            ok: false,
            error: '请求体必须是 JSON（content-type: application/json）'
          })
        }
        try {
          body = JSON.parse(raw)
        } catch {
          return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        }
      }
    }

    try {
      const result = await handlers[matched.endpoint.id]({ params: matched.params, body })
      sendJson(res, 200, {
        ok: true,
        app: SYSTEM_SERVICE_APP,
        version: SYSTEM_SERVICE_VERSION,
        ...result
      })
    } catch (error) {
      if (error instanceof SystemRequestError) {
        sendJson(res, error.status, { ok: false, error: error.message })
        return
      }
      console.error('[mica-system] 处理请求失败:', error)
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: String(error?.message || error) })
      } else {
        res.end()
      }
    })
  })

  return {
    server,
    handle,
    /** 监听 TCP——**只给测试用**，生产环境一律 `listenSocket` */
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          resolve(server.address().port)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, host)
      })
    },
    /** 监听 Unix socket；上一次进程留下的同名文件由 listenLocalSocket 负责处理 */
    listenSocket(socketPath) {
      return listenLocalSocket(server, socketPath)
    },
    close() {
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve()
          return
        }
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    }
  }
}

function buildHandlers({ probe, openSettings }) {
  return {
    checks: () => probe(),
    openSettings: async (ctx) => {
      const pane = requireAllowedPane(ctx.body?.pane)
      await openSettings(pane)
      return { pane }
    }
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new SystemRequestError('请求体过大', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
