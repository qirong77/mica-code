import { createServer } from 'node:http'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { verifyLocalRequest } from '../shared/endpoint-http.js'
import {
  BrowserRequestError,
  cookieCachePaths,
  compileRoutes,
  parseBoolean,
  resolveOwner,
  resolveRoute,
  tabSummary,
  browserSummary
} from './browser-core.js'
import {
  BROWSER_ENDPOINTS,
  BROWSER_SERVICE_APP,
  BROWSER_SERVICE_VERSION,
  buildDocsMarkdown,
  buildSkillMarkdown,
  capabilityCatalog
} from './browser-docs.js'

/**
 * 受控浏览器的 HTTP 服务。**只监听一个 Unix socket**（不占 TCP 端口），唯一入口是运行时
 * 自己在已有端口上开的 `/remote/control/*` 代理（见 host/browser-control-proxy.js），
 * 所以「谁能打到这里」由运行时那套 Host/Origin 校验定，这一层只兜底再挡一次：
 * 没有令牌 —— 能连上就能开窗口、读 cookie，所以只挡两类东西（与运行时 access-core 同一套思路）：
 *
 * - `Host` 不是本机名（挡 DNS rebinding）；
 * - 带 `Origin` 且不是本机 origin（挡「任意网页替访客静默请求 127.0.0.1」）。
 *
 * 另外刻意**不发 CORS 头**：非 GET 要 JSON 体，浏览器页面因此必然先发预检、拿不到放行头，
 * 于是页面既不能调用也不能读取响应。agent 走 Node/curl，不受影响。
 *
 * 路由表由 browser-docs.js 的端点目录编译（`compileRoutes`），端点、能力清单与文档三者同源。
 */

const MAX_BODY_BYTES = 1024 * 1024
const HEARTBEAT_MS = 15000

// 本机请求校验与终端控制共用一份实现；这里继续导出，服务契约测试仍从本模块取
export { verifyLocalRequest }

export function createBrowserService({
  getManager,
  address = () => ({ port: 0, url: '' }),
  cacheDir = ''
}) {
  const routes = compileRoutes(BROWSER_ENDPOINTS)
  const clients = new Set()

  function broadcast() {
    if (clients.size === 0) return
    const payload = JSON.stringify({
      channel: 'browser:changed',
      payload: { browsers: getManager().listBrowsers() }
    })
    for (const client of clients) {
      try {
        client.res.write(`data: ${payload}\n\n`)
      } catch {
        clients.delete(client)
      }
    }
  }

  const handlers = buildHandlers({ getManager, address, cacheDir })

  // 端点目录与实现必须一一对应：少一个 handler 就在启动时报出来，而不是等调用时 404
  // （SSE 端点由 handleEvents 直接处理，不走 handler 表）
  for (const endpoint of BROWSER_ENDPOINTS) {
    if (endpoint.method === 'SSE') continue
    if (!handlers[endpoint.id]) throw new Error(`浏览器服务缺少端点实现：${endpoint.id}`)
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
        service: '受控浏览器',
        docs: '/remote/control/browser/docs',
        health: '/remote/control/browser/health',
        capabilities: '/remote/control/browser/capabilities'
      })
    }
    const matched = resolveRoute(routes, method, url.pathname)
    if (!matched) {
      return sendJson(res, 404, { ok: false, error: `未知端点：${method} ${url.pathname}` })
    }
    if (matched.stream) return handleEvents(req, res)

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
      // 截图可以直接要字节，省掉一层 base64（agent 存文件时更省事）
      if (matched.endpoint.id === 'screenshot' && result.raw) {
        const buffer = Buffer.from(result.raw.base64, 'base64')
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': buffer.length,
          'cache-control': 'no-store'
        })
        res.end(buffer)
        return
      }
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      if (error instanceof BrowserRequestError) {
        sendJson(res, error.status, { ok: false, error: error.message })
        return
      }
      console.error('[mica-browser] 处理请求失败:', error)
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    })
    res.write(': connected\n\n')
    const client = { res }
    clients.add(client)
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

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent)
        sendJson(res, 500, { ok: false, error: String(error?.message || error) })
      else res.end()
    })
  })

  return {
    server,
    handle,
    broadcast,
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
    /**
     * 监听一个 Unix socket（不占 TCP 端口）。上一个进程留下的 socket 文件会让 listen
     * 直接 EADDRINUSE，所以先清掉——同路径上不可能有别人正在服务（它由本应用的
     * userData 目录独占）。
     */
    async listenSocket(socketPath) {
      await rm(socketPath, { force: true }).catch(() => {})
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(socketPath)
      })
      return socketPath
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
        server.close(() => resolve())
      })
    }
  }
}

function buildHandlers({ getManager, address, cacheDir = '' }) {
  const manager = () => getManager()

  return {
    health: () => ({ app: BROWSER_SERVICE_APP, version: BROWSER_SERVICE_VERSION }),

    capabilities: () => ({
      app: BROWSER_SERVICE_APP,
      version: BROWSER_SERVICE_VERSION,
      endpoints: capabilityCatalog()
    }),

    docs: () => ({
      app: BROWSER_SERVICE_APP,
      version: BROWSER_SERVICE_VERSION,
      serviceUrl: address()?.url || '',
      endpoints: BROWSER_ENDPOINTS,
      markdown: buildDocsMarkdown({ serviceUrl: address()?.url || '$MICA_BROWSER_URL' }),
      skillMarkdown: buildSkillMarkdown()
    }),

    listBrowsers: () => ({ browsers: manager().listBrowsers() }),

    createBrowser: (ctx) => ({
      browser: manager().getBrowser(
        manager().createBrowser({
          owner: ctx.owner,
          url: ctx.body.url,
          label: ctx.body.label,
          show: parseBoolean(ctx.body.show) === true
        }).id
      )
    }),

    getBrowser: (ctx) => ({ browser: manager().getBrowser(ctx.params.id) }),

    showBrowser: (ctx) => {
      const record = manager().showBrowser(ctx.params.id, {
        focus: parseBoolean(ctx.query.focus) === true
      })
      return { browser: manager().getBrowser(record.id) }
    },

    hideBrowser: (ctx) => {
      const record = manager().hideBrowser(ctx.params.id)
      return { browser: manager().getBrowser(record.id) }
    },

    closeBrowser: (ctx) => {
      manager().destroyBrowser(ctx.params.id)
      return { closed: ctx.params.id }
    },

    listTabs: (ctx) => ({ tabs: manager().listTabs(ctx.query.owner) }),

    createTab: (ctx) => {
      const { browser, tab } = manager().createTab({
        browserId: ctx.body.browserId,
        url: ctx.body.url,
        owner: ctx.owner
      })
      return { tab: tabSummary(tab), browser: browserSummary(browser) }
    },

    activateTab: (ctx) => ({ browser: manager().activateTab(ctx.params.id) }),

    closeTab: (ctx) => {
      const { browser } = manager().closeTab(ctx.params.id)
      return { browser: browser ? browserSummary(browser) : null }
    },

    navigate: async (ctx) => {
      const { tab } = await manager().navigate(ctx.params.id, {
        url: ctx.body.url,
        action: ctx.body.action
      })
      return { tab: tabSummary(tab) }
    },

    evaluate: async (ctx) => ({
      value: await manager().evaluate(ctx.params.id, {
        expression: ctx.body.expression,
        timeoutMs: Number(ctx.body.timeoutMs) || undefined
      })
    }),

    content: (ctx) =>
      manager().content(ctx.params.id, {
        format: ctx.query.format,
        maxChars: Number(ctx.query.maxChars) || undefined
      }),

    click: (ctx) =>
      manager().click(ctx.params.id, {
        selector: ctx.body.selector,
        x: ctx.body.x,
        y: ctx.body.y
      }),

    type: (ctx) =>
      manager().type(ctx.params.id, {
        selector: ctx.body.selector,
        text: ctx.body.text,
        clear: parseBoolean(ctx.body.clear) === true,
        submit: parseBoolean(ctx.body.submit) === true
      }),

    keys: (ctx) => manager().keys(ctx.params.id, ctx.body.keys),

    scroll: (ctx) => manager().scroll(ctx.params.id, { deltaY: ctx.body.deltaY }),

    screenshot: async (ctx) => {
      const shot = await manager().screenshot(ctx.params.id, {
        fullPage: parseBoolean(ctx.query.fullPage) === true
      })
      if (parseBoolean(ctx.query.raw) === true) {
        return { raw: { base64: shot.dataUrl.replace(/^data:image\/png;base64,/, '') } }
      }
      return shot
    },

    waitFor: (ctx) =>
      manager().waitFor(ctx.params.id, {
        selector: ctx.body.selector,
        text: ctx.body.text,
        url: ctx.body.url,
        timeoutMs: ctx.body.timeoutMs
      }),

    cookies: (ctx) =>
      manager().cookies(ctx.params.id, { format: ctx.query.format, url: ctx.query.url }),

    cookiesForScope: async (ctx) => {
      const url = ctx.query.url
      if (!url) throw new BrowserRequestError('缺少 url 参数')
      // 明细总是取一份：缓存文件要用它，format 只决定回给调用方的形态
      const full = await manager().cookiesForScope({ url, format: 'json' })
      const result =
        String(ctx.query.format || 'json').toLowerCase() === 'header'
          ? { url: full.url, count: full.count, cookieHeader: full.cookieHeader }
          : full
      // 默认落盘：别的进程（本地 dev server、curl、另一个会话）直接读这份缓存，不用重新登录
      if (parseBoolean(ctx.query.save) === false || !cacheDir) return result
      const saved = await saveCookieCache(cacheDir, full)
      return { ...result, saved }
    },

    console: (ctx) => ({
      entries: manager().consoleEntries(ctx.params.id, {
        clear: parseBoolean(ctx.query.clear) === true
      })
    }),

    network: (ctx) => ({
      entries: manager().networkEntries(ctx.params.id, {
        clear: parseBoolean(ctx.query.clear) === true
      })
    })
  }
}

/**
 * 把一次 cookie 读取落成固定文件（`<cacheDir>/<host>.txt` + `.json`）：别的进程按域名直接
 * 读 `.txt` 当 `Cookie:` 头用，不必自己驱动浏览器、也不用重新登录。
 *
 * 缓存只是方便，不是事实来源（真相在浏览器的持久分区里），所以写失败只回报不抛错。
 * 权限 0600：里面是登录凭据。
 */
async function saveCookieCache(cacheDir, result) {
  const { headerPath, jsonPath } = cookieCachePaths(cacheDir, result.url)
  try {
    await mkdir(dirname(headerPath), { recursive: true })
    await writeFile(headerPath, `${result.cookieHeader || ''}\n`, { mode: 0o600 })
    const detail = {
      url: result.url,
      count: result.count || 0,
      cookieHeader: result.cookieHeader || '',
      cookies: result.cookies || []
    }
    await writeFile(jsonPath, `${JSON.stringify(detail, null, 2)}\n`, { mode: 0o600 })
    return { headerPath, jsonPath }
  } catch (error) {
    return { headerPath, jsonPath, error: String(error?.message || error) }
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
        reject(new BrowserRequestError('请求体过大', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
