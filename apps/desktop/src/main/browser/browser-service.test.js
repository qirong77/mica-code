import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { notFoundError } from './browser-core.js'
import { BROWSER_ENDPOINTS } from './browser-docs.js'
import { createBrowserService, verifyLocalRequest } from './browser-service.js'

/** 假 manager：只记账，不开真窗口（真窗口在 browser-manager.js，需要 Electron） */
function createFakeManager() {
  const browsers = new Map()
  let sequence = 0
  const record = (input = {}) => {
    sequence += 1
    const browser = {
      id: `brw-${sequence}`,
      owner: input.owner || null,
      label: input.label || '受控浏览器',
      visible: Boolean(input.show),
      createdAt: '2026-01-01T00:00:00.000Z',
      activeTabId: `tab-${sequence}`,
      tabs: [
        {
          id: `tab-${sequence}`,
          browserId: `brw-${sequence}`,
          url: input.url || 'about:blank',
          title: '',
          loading: false,
          active: true
        }
      ]
    }
    browsers.set(browser.id, browser)
    return browser
  }

  return {
    record,
    listBrowsers: () => [...browsers.values()].map((item) => item),
    getBrowser: (id) => {
      const found = browsers.get(id)
      if (!found) throw notFoundError(`没有这个窗口：${id}`)
      return found
    },
    createBrowser: (input) => record(input),
    showBrowser: (id) => {
      const found = browsers.get(id)
      if (!found) throw notFoundError(`没有这个窗口：${id}`)
      found.visible = true
      return found
    },
    hideBrowser: (id) => {
      const found = browsers.get(id)
      if (!found) throw notFoundError(`没有这个窗口：${id}`)
      found.visible = false
      return found
    },
    destroyBrowser: (id) => {
      if (!browsers.delete(id)) throw notFoundError(`没有这个窗口：${id}`)
    },
    // 真实实现在列窗口前顺手销毁未归属的窗口（顶栏没有它们的入口）
    pruneUnowned: () => {
      const orphans = [...browsers.values()].filter((item) => !item.owner)
      for (const orphan of orphans) browsers.delete(orphan.id)
      return orphans.length
    },
    locate: (id) => {
      const browser = [...browsers.values()].find(
        (item) => item.id === id || item.tabs.some((tab) => tab.id === id)
      )
      return browser ? { browser, tab: browser.tabs.find((tab) => tab.id === id) } : null
    },
    // 真实实现按浏览器 / 标签页 id 反查归属，服务层拿它挡「别的会话的操作」。
    ownerOf: (id) => {
      const key = String(id || '')
      const browser = browsers.get(key)
      if (browser) return browser.owner || null
      for (const item of browsers.values()) {
        if (item.tabs.some((tab) => tab.id === key)) return item.owner || null
      }
      return null
    },
    listTabs: () => [...browsers.values()].flatMap((item) => item.tabs),
    createTab: ({ browserId }) => {
      const browser = browsers.get(browserId)
      if (!browser) throw notFoundError(`没有这个窗口：${browserId}`)
      const tab = { id: 'tab-new', browserId, url: '', title: '', loading: false, active: false }
      browser.tabs.push(tab)
      return { browser, tab }
    },
    activateTab: (id) => {
      const browser = [...browsers.values()].find((item) => item.tabs.some((tab) => tab.id === id))
      if (!browser) throw notFoundError(`没有这个标签页：${id}`)
      return browser
    },
    closeTab: (id) => {
      const browser = [...browsers.values()].find((item) => item.tabs.some((tab) => tab.id === id))
      if (!browser) throw notFoundError(`没有这个标签页：${id}`)
      return { browser }
    },
    navigate: async (id) => ({ tab: { id, url: 'https://example.com', title: '', loading: true } }),
    evaluate: async (_id, { expression }) => {
      if (expression === 'boom') throw new Error('页面里炸了')
      return { result: expression }
    },
    content: () => ({
      url: 'https://example.com',
      title: '示例',
      format: 'text',
      content: 'hi',
      truncated: false
    }),
    click: () => ({ target: { selector: '#a', x: 1, y: 2 } }),
    type: () => ({ ok: true }),
    keys: () => ({ ok: true }),
    scroll: () => ({ scrollY: 42 }),
    screenshot: async () => ({ dataUrl: 'data:image/png;base64,QUJD', bytes: 3 }),
    waitFor: () => ({ matched: true, elapsedMs: 12 }),
    cookies: () => ({ url: 'https://example.com', count: 1, cookieHeader: 'a=1', cookies: [] }),
    cookiesForScope: ({ url }) => ({
      url,
      count: 2,
      cookieHeader: 'a=1; b=2',
      cookies: [
        { name: 'a', value: '1' },
        { name: 'b', value: '2' }
      ]
    }),
    allCookies: ({ domain, limit } = {}) => {
      const cookies = [
        { name: 'a', value: '1', domain: '.example.com', path: '/', hostOnly: false },
        { name: 'b', value: '2', domain: 'other.test', path: '/', hostOnly: true }
      ].filter((cookie) => !domain || cookie.domain.endsWith(domain))
      const max = Number(limit) || 2000
      return {
        domain: domain || '',
        total: cookies.length,
        count: Math.min(cookies.length, max),
        truncated: cookies.length > max,
        cookies: cookies.slice(0, max)
      }
    },
    setCookies: (list) => ({ written: list.length, failed: [] }),
    removeCookies: (list) => ({
      removed: list.length,
      failed: list.filter((entry) => entry.name === 'boom').map((entry) => ({
        name: entry.name,
        domain: entry.domain,
        reason: '写不进去'
      }))
    }),
    consoleEntries: (_id, { clear } = {}) => [{ level: 'info', message: clear ? 'cleared' : 'hi' }],
    networkEntries: () => [{ method: 'GET', url: 'https://example.com', status: 200 }],
    calls: { type: 0 },
    id: undefined
  }
}

let manager = createFakeManager()
let service = null
let base = ''
let cookieCacheDir = ''

beforeAll(async () => {
  manager = createFakeManager()
  cookieCacheDir = await mkdtemp(join(tmpdir(), 'mica-browser-cookies-'))
  service = createBrowserService({
    getManager: () => manager,
    address: () => ({ port: 18767, url: `http://127.0.0.1:18767` }),
    cacheDir: cookieCacheDir
  })
  const port = await service.listen(0)
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await service.close()
  await rm(cookieCacheDir, { recursive: true, force: true })
})

async function call(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  })
  if (raw)
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      buffer: await response.arrayBuffer()
    }
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

describe('service surface', () => {
  it('answers the service root with entry points instead of 404', async () => {
    const root = await call('/')
    expect(root.status).toBe(200)
    expect(root.body).toMatchObject({
      ok: true,
      docs: '/remote/control/browser/docs',
      health: '/remote/control/browser/health'
    })
  })

  it('answers health, capabilities and docs from the same endpoint catalog', async () => {
    const health = await call('/browser/health')
    expect(health.body).toMatchObject({ ok: true, app: 'mica-code-browser' })

    const capabilities = await call('/browser/capabilities')
    expect(capabilities.body.endpoints).toHaveLength(BROWSER_ENDPOINTS.length)

    const docs = await call('/browser/docs')
    expect(docs.body.endpoints).toHaveLength(BROWSER_ENDPOINTS.length)
    expect(docs.body.serviceUrl).toBe('http://127.0.0.1:18767')
    expect(docs.body.markdown).toContain('http://127.0.0.1:18767')
    expect(docs.body.markdown).toContain('x-mica-owner')
    // 给 agent 的短提示与端点目录同源：MCP 的 doc 列表直接用这一段。
    expect(docs.body.guide).toContain('waitFor')
  })

  it('rejects unknown endpoints and unsafe methods', async () => {
    expect((await call('/browser/nope')).status).toBe(404)
    expect((await call('/browser/browsers', { method: 'DELETE' })).status).toBe(404)
    expect((await call('/browser/events', { method: 'POST', body: {} })).status).toBe(404)
    expect((await call('/browser/cookies/events', { method: 'POST', body: {} })).status).toBe(404)
  })

  it('requires a JSON content type for writes and a valid body', async () => {
    const wrongType = await call('/browser/browsers', {
      method: 'POST',
      body: JSON.stringify({ url: 'example.com' }),
      headers: { 'content-type': 'text/plain' }
    })
    expect(wrongType.status).toBe(415)

    const broken = await call('/browser/browsers', { method: 'POST', body: '{' })
    expect(broken.status).toBe(400)
    expect(broken.body.error).toContain('JSON')
  })
})

describe('ownership', () => {
  it('takes the owner from the header first', async () => {
    const created = await call('/browser/browsers', {
      method: 'POST',
      body: { url: 'example.com', label: '登录页', owner: 'from-body' },
      headers: { 'x-mica-owner': 'from-header' }
    })
    expect(created.body.browser.owner).toBe('from-header')
    expect(created.body.browser.label).toBe('登录页')
  })

  it('falls back to the body, and refuses a request that carries no owner at all', async () => {
    const withBody = await call('/browser/browsers', { method: 'POST', body: { owner: 'sess-9' } })
    expect(withBody.body.browser.owner).toBe('sess-9')

    const orphan = await call('/browser/browsers', { method: 'POST', body: {} })
    expect(orphan.status).toBe(400)
    expect(orphan.body.error).toContain('x-mica-owner')
  })

  it('destroys windows that lost their owner before listing', async () => {
    const orphan = manager.record({ owner: null })
    const owned = manager.record({ owner: 'sess-keep' })
    const listed = await call('/browser/browsers')
    const ids = listed.body.browsers.map((item) => item.id)
    expect(ids).not.toContain(orphan.id)
    expect(ids).toContain(owned.id)
  })

  // 与终端同一套语义：带归属的调用只能碰自己名下的窗口 / 标签页，不带归属的是「人」
  // （页面要能唤出 agent 开出来的窗口）。少了这一层，两个会话的 agent 可以互相往对方
  // 已经登录的页面里打字。
  it('refuses to drive another session’s browser or tab', async () => {
    const created = await call('/browser/browsers', {
      method: 'POST',
      body: { url: 'example.com', owner: 'sess-a' }
    })
    const browserId = created.body.browser.id
    const tabId = created.body.browser.tabs[0].id

    const foreignType = await call(`/browser/tabs/${tabId}/type`, {
      method: 'POST',
      body: { text: 'hello' },
      headers: { 'x-mica-owner': 'sess-b' }
    })
    expect(foreignType.status).toBe(403)
    expect(foreignType.body.error).toContain('另一个会话')

    const foreignClose = await call(`/browser/browsers/${browserId}/close`, {
      method: 'POST',
      headers: { 'x-mica-owner': 'sess-b' }
    })
    expect(foreignClose.status).toBe(403)

    // 自己的窗口、以及不带归属的页面调用都照常。
    expect(
      (
        await call(`/browser/tabs/${tabId}/type`, {
          method: 'POST',
          body: { text: 'hello' },
          headers: { 'x-mica-owner': 'sess-a' }
        })
      ).status
    ).toBe(200)
    expect((await call(`/browser/tabs/${tabId}/type`, { method: 'POST', body: { text: 'hi' } })).status).toBe(200)
  })
})

describe('browser and tab operations', () => {
  it('lists, shows, hides and destroys', async () => {
    const created = await call('/browser/browsers', {
      method: 'POST',
      body: { url: 'example.com', owner: 'sess-ops' }
    })
    const id = created.body.browser.id

    expect((await call('/browser/browsers')).body.browsers.length).toBeGreaterThan(0)
    const shown = await call(`/browser/browsers/${id}/show?focus=1`, { method: 'POST' })
    expect(shown.body.browser.visible).toBe(true)
    expect(
      (await call(`/browser/browsers/${id}/hide`, { method: 'POST' })).body.browser.visible
    ).toBe(false)

    const closed = await call(`/browser/browsers/${id}/close`, { method: 'POST' })
    expect(closed.body.closed).toBe(id)
    expect((await call('/browser/browsers')).body.browsers.some((item) => item.id === id)).toBe(
      false
    )
  })

  it('maps a missing browser to 404 and a page error to 500', async () => {
    const missing = await call('/browser/browsers/brw-nope')
    expect(missing.status).toBe(404)
    expect(missing.body.ok).toBe(false)

    const created = await call('/browser/browsers', {
      method: 'POST',
      body: { owner: 'sess-ops' }
    })
    const tabId = created.body.browser.tabs[0].id
    const boom = await call(`/browser/tabs/${tabId}/evaluate`, {
      method: 'POST',
      body: { expression: 'boom' }
    })
    expect(boom.status).toBe(500)
    expect(boom.body.error).toBe('页面里炸了')
  })

  it('passes cookies and console flags through', async () => {
    const created = await call('/browser/browsers', {
      method: 'POST',
      body: { url: 'example.com', owner: 'sess-ops' }
    })
    const tabId = created.body.browser.tabs[0].id

    const cookies = await call(`/browser/tabs/${tabId}/cookies?format=header`)
    expect(cookies.body.cookieHeader).toBe('a=1')

    const cleared = await call(`/browser/tabs/${tabId}/console?clear=1`)
    expect(cleared.body.entries[0].message).toBe('cleared')
  })

  it('reads cookies by url scope and caches them to a fixed file', async () => {
    const missing = await call('/browser/cookies')
    expect(missing.status).toBe(400)
    expect(missing.body.error).toContain('url')

    const scope = 'https://osim108.zuche-saas.osim.intra.xiaojukeji.com/'
    const read = await call(`/browser/cookies?format=header&url=${encodeURIComponent(scope)}`)
    expect(read.body.cookieHeader).toBe('a=1; b=2')
    expect(read.body.saved.headerPath).toBe(
      join(cookieCacheDir, 'osim108.zuche-saas.osim.intra.xiaojukeji.com.txt')
    )

    const cached = await readFile(read.body.saved.headerPath, 'utf8')
    expect(cached.trim()).toBe('a=1; b=2')
    const detail = JSON.parse(await readFile(read.body.saved.jsonPath, 'utf8'))
    expect(detail.cookies).toHaveLength(2)
  })

  it('enumerates, writes and removes cookies for a whole partition', async () => {
    const all = await call('/browser/cookies/all')
    expect(all.body.total).toBe(2)
    expect(all.body.truncated).toBe(false)

    const one = await call('/browser/cookies/all?domain=example.com&limit=1')
    expect(one.body.domain).toBe('example.com')
    expect(one.body.count).toBe(1)
    expect(one.body.total).toBe(1)

    const capped = await call('/browser/cookies/all?limit=1')
    expect(capped.body.count).toBe(1)
    expect(capped.body.truncated).toBe(true)

    const written = await call('/browser/cookies/set', {
      method: 'POST',
      body: {
        cookies: [
          { name: 's', value: 'v', domain: '.example.com', path: '/', secure: true },
          { name: 'b', value: '2', domain: 'other.test', path: '/', secure: true, hostOnly: true }
        ]
      }
    })
    expect(written.body).toMatchObject({ ok: true, written: 2, failed: [] })

    const removed = await call('/browser/cookies/remove', {
      method: 'POST',
      body: { cookies: [{ name: 's', domain: '.example.com', path: '/' }] }
    })
    expect(removed.body).toMatchObject({ ok: true, removed: 1 })

    // 单条写不进去不该中断整批：失败原因原样回给调用方
    const partial = await call('/browser/cookies/remove', {
      method: 'POST',
      body: { cookies: [{ name: 'boom', domain: 'other.test' }, { name: 'ok', domain: 'other.test' }] }
    })
    expect(partial.body.removed).toBe(2)
    expect(partial.body.failed).toHaveLength(1)
  })

  it('refuses an empty or malformed cookie batch', async () => {
    const empty = await call('/browser/cookies/set', { method: 'POST', body: { cookies: [] } })
    expect(empty.status).toBe(400)
    const notArray = await call('/browser/cookies/remove', { method: 'POST', body: { cookies: 'x' } })
    expect(notArray.status).toBe(400)
  })

  it('returns the png bytes directly when raw=1 is asked for', async () => {
    const created = await call('/browser/browsers', {
      method: 'POST',
      body: { owner: 'sess-ops' }
    })
    const tabId = created.body.browser.tabs[0].id

    const json = await call(`/browser/tabs/${tabId}/screenshot`)
    expect(json.body.dataUrl).toStartWith('data:image/png;base64,')

    const raw = await call(`/browser/tabs/${tabId}/screenshot?raw=1`, { raw: true })
    expect(raw.status).toBe(200)
    expect(raw.type).toContain('image/png')
    expect(new Uint8Array(raw.buffer)).toEqual(new Uint8Array([65, 66, 67]))
  })
})

describe('local-only guard', () => {
  it('accepts only localhost hosts and origins', () => {
    expect(verifyLocalRequest({ headers: { host: '127.0.0.1:18767' } })).toEqual({ ok: true })
    expect(
      verifyLocalRequest({ headers: { host: 'localhost:18767', origin: 'http://localhost:5173' } })
    ).toEqual({ ok: true })
    expect(verifyLocalRequest({ headers: { host: 'evil.example' } })).toMatchObject({ status: 403 })
    expect(
      verifyLocalRequest({ headers: { host: '127.0.0.1', origin: 'https://evil.example' } })
    ).toMatchObject({ status: 403 })
  })

  it('refuses a cross-site browser request end to end', async () => {
    const denied = await call('/browser/browsers', { headers: { origin: 'https://evil.example' } })
    expect(denied.status).toBe(403)
    expect(denied.body.error).toContain('跨站')

    const deniedCookieStream = await call('/browser/cookies/events', {
      headers: { origin: 'https://evil.example' }
    })
    expect(deniedCookieStream.status).toBe(403)
  })
})

describe('event stream', () => {
  it('sends cookie identity changes only to the dedicated stream', async () => {
    const cookieController = new AbortController()
    const uiController = new AbortController()
    try {
      const cookieResponse = await fetch(`${base}/browser/cookies/events`, {
        signal: cookieController.signal
      })
      const uiResponse = await fetch(`${base}/browser/events`, { signal: uiController.signal })
      expect(cookieResponse.headers.get('content-type')).toContain('text/event-stream')
      const cookieReader = cookieResponse.body.getReader()
      const uiReader = uiResponse.body.getReader()
      await cookieReader.read()
      await uiReader.read()

      const uiNext = uiReader.read()
      service.broadcastCookieChange({
        cookie: { name: 'sid', domain: '.example.com', path: '/account', value: 'secret' },
        removed: true,
        cause: 'expired'
      })
      const frame = new TextDecoder().decode((await cookieReader.read()).value)
      expect(JSON.parse(frame.slice(frame.indexOf('data: ') + 6))).toEqual({
        cookie: { name: 'sid', domain: '.example.com', path: '/account' },
        removed: true,
        cause: 'expired'
      })
      expect(frame).not.toContain('secret')

      const cookieNext = cookieReader.read()
      service.broadcast()
      const uiFrame = new TextDecoder().decode((await uiNext).value)
      expect(uiFrame).toContain('browser:changed')
      expect(uiFrame).not.toContain('sid')
      expect(uiFrame).not.toContain('secret')
      service.broadcastCookieChange({ cookie: { name: 'next', domain: 'example.com', path: '/' } })
      const nextCookieFrame = new TextDecoder().decode((await cookieNext).value)
      expect(nextCookieFrame).toContain('"name":"next"')
      expect(nextCookieFrame).not.toContain('browser:changed')
    } finally {
      cookieController.abort()
      uiController.abort()
    }
  })

  it('pushes window changes to connected subscribers', async () => {
    const controller = new AbortController()
    const response = await fetch(`${base}/browser/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal
    })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    const first = decoder.decode((await reader.read()).value)
    expect(first).toContain(': connected')

    // 请求体读完之后订阅者必须还在：`req.on('close')` 若被当成「这一次请求结束」就会立刻把
    // SSE 客户端摘掉，桌面端的浏览器图标从此不再自己更新（只有手动刷新才动）。
    await new Promise((resolve) => setTimeout(resolve, 300))
    service.broadcast()

    let text = ''
    for (let index = 0; index < 5 && !text.includes('browser:changed'); index += 1) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value)
    }
    expect(text).toContain('browser:changed')
    expect(JSON.parse(text.slice(text.indexOf('data: ') + 6).trim()).payload.browsers).toBeArray()
    controller.abort()
  })

  it('announces which window a session just touched', async () => {
    const controller = new AbortController()
    const response = await fetch(`${base}/browser/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal
    })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    await reader.read() // `: connected`

    const created = await call('/browser/browsers', {
      method: 'POST',
      body: { owner: 'sess-flash' }
    })
    const id = created.body.browser.id

    let text = ''
    for (let index = 0; index < 6 && !text.includes('browser:activity'); index += 1) {
      const { value, done } = await reader.read()
      if (done) break
      text += decoder.decode(value)
    }
    const frame = text.split('\n').find((line) => line.includes('browser:activity'))
    expect(JSON.parse(frame.slice(6)).payload).toMatchObject({ id, owner: 'sess-flash' })
    controller.abort()
  })
})
