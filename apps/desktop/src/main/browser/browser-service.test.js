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
    // 技能文档由服务原样给出占位符，运行时写盘前才换成真实地址（browser-control.js）。
    expect(docs.body.skillMarkdown).toContain('$MICA_BROWSER_URL')
  })

  it('rejects unknown endpoints and unsafe methods', async () => {
    expect((await call('/browser/nope')).status).toBe(404)
    expect((await call('/browser/browsers', { method: 'DELETE' })).status).toBe(404)
    expect((await call('/browser/events', { method: 'POST', body: {} })).status).toBe(404)
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

  it('falls back to the body and then to unowned', async () => {
    const withBody = await call('/browser/browsers', { method: 'POST', body: { owner: 'sess-9' } })
    expect(withBody.body.browser.owner).toBe('sess-9')

    const orphan = await call('/browser/browsers', { method: 'POST', body: {} })
    expect(orphan.body.browser.owner).toBeNull()
  })
})

describe('browser and tab operations', () => {
  it('lists, shows, hides and destroys', async () => {
    const created = await call('/browser/browsers', {
      method: 'POST',
      body: { url: 'example.com' }
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

    const created = await call('/browser/browsers', { method: 'POST', body: {} })
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
      body: { url: 'example.com' }
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

  it('returns the png bytes directly when raw=1 is asked for', async () => {
    const created = await call('/browser/browsers', { method: 'POST', body: {} })
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
  })
})

describe('event stream', () => {
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
})
