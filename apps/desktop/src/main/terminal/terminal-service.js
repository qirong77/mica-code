/**
 * 终端控制的 HTTP 服务。**只监听一个 Unix socket**（不占 TCP 端口），唯一入口是运行时
 * 在自己端口上开的 `/remote/terminal/*` 代理，所以「谁能打到这里」由运行时那套 Host/Origin
 * 校验定；这一层再兜底挡一次 DNS rebinding 与跨站网页（与受控浏览器同一套，见
 * shared/endpoint-http.js），并且刻意不发 CORS 头。
 *
 * 路由表由 terminal-docs.js 的端点目录编译，端点、能力清单与文档三者同源。
 */

import { createServer } from 'node:http'
import {
  compileRoutes,
  listenLocalSocket,
  parseBoolean,
  resolveOwner,
  resolveRoute,
  verifyLocalRequest
} from '../shared/endpoint-http.js'
import {
  TERMINAL_SERVICE_APP,
  TERMINAL_SERVICE_VERSION,
  TerminalRequestError
} from './terminal-core.js'
import {
  TERMINAL_ENDPOINTS,
  buildDocsMarkdown,
  buildSkillMarkdown,
  capabilityCatalog
} from './terminal-docs.js'

const MAX_BODY_BYTES = 1024 * 1024
const HEARTBEAT_MS = 15000

export function createTerminalService({ sessions, windows, address = () => ({ url: '' }) }) {
  const routes = compileRoutes(TERMINAL_ENDPOINTS)
  const clients = new Set()

  function send(client, channel, payload) {
    // 客户端读得慢（隐藏窗口、远端页面）时不再往里堆输出，避免主进程无界缓存整段日志；
    // 状态帧照旧送，输出靠 seq 重放恢复
    if (client.backedUp && channel === 'terminal:output') {
      client.skippedOutput = true
      return
    }
    try {
      const flushed = client.res.write(`data: ${JSON.stringify({ channel, payload })}\n\n`)
      if (!flushed) client.backedUp = true
    } catch {
      clients.delete(client)
    }
  }

  function broadcast(channel, payload, match) {
    for (const client of clients) {
      if (match && !match(client)) continue
      send(client, channel, payload)
    }
  }

  /**
   * 会话事件 → SSE：
   * - 输出只发给订阅了这条会话的客户端（页面），事件里带 seq 区间便于续传；
   * - 状态变化发给「正在看这条会话的页面」和不限定会话的列表订阅者。别无脑广播：
   *   一个终端 resize 会让所有页面重渲染，远端标签页尤其明显。
   */
  function onSessionEvent(event) {
    if (event.type === 'output') {
      broadcast(
        'terminal:output',
        {
          session: event.session.id,
          seqFrom: event.seqFrom,
          seq: event.seq,
          data: event.chunk
        },
        (client) => client.sessionId === event.session.id
      )
      return
    }
    broadcast(
      'terminal:changed',
      { reason: event.type, session: event.summary },
      (client) => !client.sessionId || client.sessionId === event.session.id
    )
    // 会话可能被端点关闭，也可能被空闲回收关掉：统一在这里销毁窗口，避免留下一个
    // 指向已删除会话的孤儿窗口（页面重建时会 404）。先广播再销毁，浏览器里的页面
    // 还能收到「已关闭」这一帧。
    if (event.type === 'closed') {
      try {
        windows.destroy(event.session.id)
      } catch {
        // 窗口可能已经从别处销毁
      }
    }
  }

  const handlers = buildHandlers({ sessions, windows, address })

  for (const endpoint of TERMINAL_ENDPOINTS) {
    if (endpoint.method === 'SSE') continue
    if (!handlers[endpoint.id]) throw new Error(`终端服务缺少端点实现：${endpoint.id}`)
  }

  async function handle(req, res) {
    const guard = verifyLocalRequest(req)
    if (!guard.ok) return sendJson(res, guard.status, { ok: false, error: guard.error })

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    const method = req.method === 'HEAD' ? 'GET' : req.method
    // 服务根没有端点：直接用浏览器打开这个地址时给一份入口，别让 404 看起来像「服务没起来」
    if (url.pathname === '/') {
      return sendJson(res, 200, {
        ok: true,
        service: '终端控制',
        docs: '/remote/terminal/docs',
        sessions: '/remote/terminal/sessions',
        events: '/remote/terminal/events'
      })
    }
    const matched = resolveRoute(routes, method, url.pathname)
    if (!matched) {
      return sendJson(res, 404, { ok: false, error: `未知端点：${method} ${url.pathname}` })
    }
    if (matched.stream) return handleEvents(req, res, url)

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

    const context = {
      params: matched.params,
      query: Object.fromEntries(url.searchParams.entries()),
      body: body && typeof body === 'object' ? body : {},
      owner: resolveOwner({
        headers: req.headers,
        body,
        query: Object.fromEntries(url.searchParams)
      })
    }

    try {
      const result = await handlers[matched.endpoint.id](context)
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      if (error instanceof TerminalRequestError) {
        sendJson(res, error.status, { ok: false, error: error.message })
        return
      }
      console.error('[mica-terminal] 处理请求失败:', error)
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent)
        sendJson(res, 500, { ok: false, error: String(error?.message || error) })
      else res.end()
    })
  })

  function handleEvents(req, res, url) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    res.write(': connected\n\n')
    const sessionId = url.searchParams.get('session') || ''
    const client = { res, sessionId, backedUp: false, skippedOutput: false }
    clients.add(client)

    // 缓冲排空后告诉页面「刚才漏了输出，按当前屏幕重建一次」
    res.on('drain', () => {
      client.backedUp = false
      if (!client.skippedOutput) return
      client.skippedOutput = false
      send(client, 'terminal:resync', { session: sessionId })
    })

    // 断线/换窗口后重连：先把缓冲里缺的那段补上，页面不必重建整屏
    if (sessionId) {
      try {
        const since = Number.parseInt(url.searchParams.get('since') || '0', 10) || 0
        const replay = sessions.readOutput(sessionId, { since })
        send(client, 'terminal:output', {
          session: sessionId,
          seqFrom: since,
          seq: replay.seq,
          data: replay.data,
          truncated: replay.truncated
        })
        send(client, 'terminal:changed', {
          reason: 'snapshot',
          session: safeSummary(sessions, sessionId)
        })
      } catch {
        // 会话不存在：保持订阅，后续 created 事件仍可到达（页面会自己提示）
      }
    }

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {
        // 连接已断，由 close 清理
      }
    }, HEARTBEAT_MS)
    heartbeat.unref?.()

    const cleanup = () => {
      clearInterval(heartbeat)
      clients.delete(client)
    }
    req.on('close', cleanup)
    res.on('error', cleanup)
  }

  return {
    server,
    handle,
    onSessionEvent,
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
    /** 监听 Unix socket；先清掉上一次进程留下的同名文件，否则 listen 会 EADDRINUSE */
    async listenSocket(socketPath) {
      return listenLocalSocket(server, socketPath)
    },
    close() {
      for (const client of clients) {
        try {
          client.res.end()
        } catch {
          // 连接已断
        }
      }
      clients.clear()
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve()
          return
        }
        // 在途的 /wait 最长能挂 120s，退出时不能被它拖住：先给普通请求一点收尾时间，
        // 再把剩余连接直接断掉
        const forceTimer = setTimeout(() => server.closeAllConnections?.(), 200)
        const hardTimer = setTimeout(() => {
          server.closeAllConnections?.()
          resolve()
        }, 1500)
        forceTimer.unref?.()
        hardTimer.unref?.()
        server.close(() => {
          clearTimeout(forceTimer)
          clearTimeout(hardTimer)
          resolve()
        })
      })
    }
  }
}

function safeSummary(sessions, id) {
  try {
    return sessions.summary(sessions.get(id))
  } catch {
    return null
  }
}

/**
 * 归属护栏：带 owner 的请求只能操作自己名下的终端。
 *
 * 不带 owner 的是「人」——页面、本机 curl 都能直接接管任意终端，这是有意的：页面要能
 * 接管 agent 开出来的终端。它挡的是多个聊天会话互相串台（例如 A 往 B 的 shell 里打字），
 * 不是权限边界（同一台机器上的进程本来就能不带 owner）。
 */
function assertOwner(session, ctx) {
  if (!ctx.owner || !session.owner || session.owner === ctx.owner) return session
  throw new TerminalRequestError('这个终端属于另一个会话，不能直接操作', 403)
}

function buildHandlers({ sessions, windows, address }) {
  return {
    health: () => ({ app: TERMINAL_SERVICE_APP, version: TERMINAL_SERVICE_VERSION }),

    capabilities: () => ({
      app: TERMINAL_SERVICE_APP,
      version: TERMINAL_SERVICE_VERSION,
      endpoints: capabilityCatalog()
    }),

    docs: () => ({
      app: TERMINAL_SERVICE_APP,
      version: TERMINAL_SERVICE_VERSION,
      // 主进程只监听 socket，不知道自己对外暴露的地址；agent 用自己的环境变量
      serviceUrl: address()?.url || '$MICA_TERMINAL_URL',
      endpoints: TERMINAL_ENDPOINTS,
      markdown: buildDocsMarkdown({ serviceUrl: address()?.url || '$MICA_TERMINAL_URL' }),
      skillMarkdown: buildSkillMarkdown()
    }),

    // ctx.owner 已经合并了 header / body / query：agent 按文档只带 x-mica-owner 也能只看自己的
    listSessions: (ctx) => ({ sessions: sessions.list({ owner: ctx.owner }) }),

    createSession: (ctx) => {
      // 窗口按需创建：只是让 AI 跑命令的会话不需要渲染进程（一个窗口约 100MB 以上），
      // 要给人看的时候 show 会补开窗口
      return sessions
        .create({
          owner: ctx.owner,
          cwd: ctx.body.cwd,
          shell: ctx.body.shell,
          cols: ctx.body.cols,
          rows: ctx.body.rows,
          label: ctx.body.label
        })
        .then((session) => {
          if (parseBoolean(ctx.body.show) === true) {
            windows.ensure(session, { show: true, focus: true })
          }
          return { session: sessions.summary(session) }
        })
    },

    getSession: async (ctx) => ({
      session: await sessions.detail(ctx.params.id, { maxLines: ctx.query.maxLines })
    }),

    readOutput: (ctx) => sessions.readOutput(ctx.params.id, { since: ctx.query.since }),

    writeInput: (ctx) => sessions.write(assertOwner(sessions.get(ctx.params.id), ctx).id, ctx.body),

    keys: (ctx) => sessions.keys(assertOwner(sessions.get(ctx.params.id), ctx).id, ctx.body.keys),

    resize: async (ctx) => ({
      session: await sessions.resize(assertOwner(sessions.get(ctx.params.id), ctx).id, ctx.body)
    }),

    waitFor: (ctx) => sessions.waitFor(ctx.params.id, ctx.body),

    showSession: (ctx) => {
      const session = sessions.get(ctx.params.id)
      windows.ensure(session, { show: true, focus: true })
      // 窗口事件是异步的，这里同步一次，免得调用方立刻读到的 windowVisible 还是旧值
      sessions.setWindowVisible(session.id, true)
      return { session: sessions.summary(session) }
    },

    hideSession: (ctx) => {
      const session = sessions.get(ctx.params.id)
      windows.hide(session.id)
      sessions.setWindowVisible(session.id, false)
      return { session: sessions.summary(session) }
    },

    closeSession: (ctx) => {
      assertOwner(sessions.get(ctx.params.id), ctx)
      const { closed } = sessions.close(ctx.params.id)
      windows.destroy(ctx.params.id)
      return { closed }
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
        reject(new TerminalRequestError('请求体过大', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
