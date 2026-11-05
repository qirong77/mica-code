import { describe, expect, it } from 'bun:test'
import {
  BrowserRequestError,
  BROWSER_UNTHROTTLE_SWITCH,
  applyBrowserRenderSwitch,
  browserUnthrottleEnabled,
  browserSummary,
  compileRoutes,
  createTabSwitcher,
  cookieScopeUrl,
  formatCookieHeader,
  keyDescriptors,
  matchPath,
  normalizeCookieDomain,
  normalizeCookiePayload,
  normalizeOwner,
  normalizeUrl,
  normalizeWaitCondition,
  parseBoolean,
  parsePositiveInt,
  pickNetworkHeaders,
  publicCookie,
  resolveOwner,
  resolveRoute,
  serializeEvaluation,
  sortCookiesForHeader,
  tabSummary,
  toElectronCookie,
  truncateOutput,
  visibilityEventName
} from './browser-core.js'

describe('matchPath / resolveRoute', () => {
  it('extracts params and decodes them', () => {
    expect(matchPath('/browser/tabs/:id/navigate', '/browser/tabs/tab-1/navigate')).toEqual({
      id: 'tab-1'
    })
    expect(matchPath('/browser/tabs/:id', '/browser/tabs/a%20b')).toEqual({ id: 'a b' })
  })

  it('rejects a different shape, an empty segment or a missing literal', () => {
    expect(matchPath('/browser/tabs/:id', '/browser/tabs')).toBeNull()
    expect(matchPath('/browser/tabs/:id', '/browser/tabs/')).toBeNull()
    expect(matchPath('/browser/tabs/:id', '/browser/browsers/x')).toBeNull()
    expect(matchPath('/browser/tabs/:id/activate', '/browser/tabs/x')).toBeNull()
  })

  it('routes SSE endpoints as GET streams and keeps other methods', () => {
    const routes = compileRoutes([
      { id: 'events', method: 'SSE', path: '/browser/events' },
      { id: 'create', method: 'POST', path: '/browser/browsers' }
    ])
    expect(resolveRoute(routes, 'GET', '/browser/events')).toMatchObject({ stream: true })
    expect(resolveRoute(routes, 'POST', '/browser/events')).toBeNull()
    expect(resolveRoute(routes, 'GET', '/browser/browsers')).toBeNull()
    expect(resolveRoute(routes, 'POST', '/browser/browsers')).toMatchObject({ stream: false })
  })
})

describe('normalizeUrl', () => {
  it('adds https to a bare host and keeps an explicit scheme', () => {
    expect(normalizeUrl('example.com/a')).toBe('https://example.com/a')
    expect(normalizeUrl('//example.com')).toBe('https://example.com')
    expect(normalizeUrl('http://127.0.0.1:3000/x')).toBe('http://127.0.0.1:3000/x')
    expect(normalizeUrl('about:blank')).toBe('about:blank')
    expect(normalizeUrl('  ')).toBe('')
  })
})

describe('resolveOwner', () => {
  it('prefers the header, then body, then query', () => {
    expect(resolveOwner({ headers: { 'x-mica-owner': 'sess-1' }, body: { owner: 'b' } })).toBe(
      'sess-1'
    )
    expect(resolveOwner({ headers: {}, body: { owner: 'body-owner' } })).toBe('body-owner')
    expect(resolveOwner({ headers: {}, body: {}, query: { owner: 'q' } })).toBe('q')
    expect(resolveOwner({})).toBeNull()
  })

  it('trims, drops blank values and caps the length', () => {
    expect(normalizeOwner('  sess-1  ')).toBe('sess-1')
    expect(normalizeOwner('   ')).toBeNull()
    expect(normalizeOwner(undefined)).toBeNull()
    expect(normalizeOwner('x'.repeat(200))).toHaveLength(120)
  })
})

describe('summaries', () => {
  const record = {
    id: 'brw-1',
    owner: 'sess-1',
    label: '订单页',
    visible: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    activeTabId: 'tab-2',
    tabs: [
      { id: 'tab-1', browserId: 'brw-1', url: 'https://a.example', title: 'A', loading: false },
      { id: 'tab-2', browserId: 'brw-1', url: 'https://b.example', title: '', loading: true }
    ]
  }

  it('projects the active tab into the browser row', () => {
    const summary = browserSummary(record)
    expect(summary).toMatchObject({
      id: 'brw-1',
      owner: 'sess-1',
      label: '订单页',
      visible: true,
      url: 'https://b.example',
      loading: true,
      activeTabId: 'tab-2'
    })
    expect(summary.tabs).toHaveLength(2)
    // 没有标题时退回 url，界面不该出现空行
    expect(summary.tabs[1].title).toBe('https://b.example')
    expect(summary.tabs[1].active).toBe(false)
  })

  it('falls back to the first tab and to a placeholder title', () => {
    expect(
      browserSummary({ id: 'b', label: 'x', tabs: [{ id: 't', url: 'about:blank' }] })
    ).toMatchObject({
      url: 'about:blank',
      title: 'about:blank'
    })
    expect(browserSummary({ id: 'b', label: 'x', tabs: [] }).title).toBe('新标签页')
    expect(browserSummary(null)).toBeNull()
    expect(tabSummary(null)).toBeNull()
  })
})

describe('cookies', () => {
  const cookies = [
    { name: 'a', value: '1', path: '/', creationDate: 10 },
    { name: 'a', value: 'deep', path: '/admin/x', creationDate: 20 },
    { name: 'b', value: '2', path: '/admin', creationDate: 5 }
  ]

  it('sends longer paths first so a same-name cookie resolves like Chromium', () => {
    expect(sortCookiesForHeader(cookies).map((cookie) => cookie.value)).toEqual(['deep', '2', '1'])
    expect(formatCookieHeader(cookies)).toBe('a=deep; b=2; a=1')
  })

  it('tolerates missing values and an empty list', () => {
    expect(formatCookieHeader([])).toBe('')
    expect(formatCookieHeader(null)).toBe('')
    expect(formatCookieHeader([{ name: 'x' }])).toBe('x=')
  })

  it('projects the fields a caller needs, including httpOnly', () => {
    expect(publicCookie({ name: 's', value: 'v', httpOnly: true })).toMatchObject({
      name: 's',
      value: 'v',
      path: '/',
      httpOnly: true,
      session: false,
      sameSite: 'unspecified'
    })
  })
})

describe('cookie writes', () => {
  it('builds the scope url from domain + path so a delete only hits that path', () => {
    expect(cookieScopeUrl({ domain: '.example.com', path: '/admin', secure: true })).toBe(
      'https://example.com/admin'
    )
    expect(cookieScopeUrl({ domain: 'example.com' })).toBe('https://example.com/')
    expect(cookieScopeUrl({ url: 'http://example.com/x', domain: '' })).toBe('https://example.com/')
    expect(cookieScopeUrl({ url: 'http://example.com/x', secure: false })).toBe('http://example.com/')
    expect(() => cookieScopeUrl({})).toThrow(BrowserRequestError)
  })

  it('keeps host-only cookies host-only and drops an unknown sameSite', () => {
    const hostOnly = toElectronCookie({ name: 's', value: 'v', domain: 'example.com', hostOnly: true })
    expect(hostOnly).toMatchObject({ name: 's', url: 'https://example.com/', sameSite: 'unspecified' })
    expect(hostOnly.domain).toBeUndefined()
    expect(toElectronCookie({ name: 's', value: 'v', domain: '.example.com' }).domain).toBe(
      '.example.com'
    )
    expect(toElectronCookie({ name: 's', value: 'v', domain: 'example.com', sameSite: 'lax' })).toMatchObject(
      { sameSite: 'lax' }
    )
    expect(() => toElectronCookie({ value: 'v', domain: 'example.com' })).toThrow(BrowserRequestError)
  })

  it('treats a missing expirationDate as a session cookie, not the epoch', () => {
    expect(toElectronCookie({ name: 's', domain: 'example.com' }).expirationDate).toBeUndefined()
    expect(toElectronCookie({ name: 's', domain: 'example.com', expirationDate: 0 }).expirationDate).toBeUndefined()
    expect(
      toElectronCookie({ name: 's', domain: 'example.com', expirationDate: 1767225600 }).expirationDate
    ).toBe(1767225600)
  })

  it('normalizes the domain filter the way cookies.get wants it', () => {
    expect(normalizeCookieDomain('https://a.example.com/x')).toBe('a.example.com')
    expect(normalizeCookieDomain('.example.com')).toBe('example.com')
    expect(normalizeCookieDomain('')).toBe('')
    expect(normalizeCookieDomain('::::')).toBe('')
  })

  it('rejects a payload that is not an array of cookies', () => {
    expect(normalizeCookiePayload([{ name: 'a' }, null])).toEqual([{ name: 'a' }])
    expect(() => normalizeCookiePayload('nope')).toThrow(BrowserRequestError)
    expect(() => normalizeCookiePayload([{ name: 'a' }], { limit: 0 })).toThrow(BrowserRequestError)
  })
})

describe('parseBoolean / parsePositiveInt / truncateOutput', () => {
  it('parses the usual truthy spellings', () => {
    expect(parseBoolean('1')).toBe(true)
    expect(parseBoolean('TRUE')).toBe(true)
    expect(parseBoolean('off')).toBe(false)
    expect(parseBoolean('maybe')).toBeUndefined()
    expect(parseBoolean(true)).toBe(true)
    expect(parseBoolean(undefined)).toBeUndefined()
  })

  it('keeps positive integers only', () => {
    expect(parsePositiveInt('30', 5)).toBe(30)
    expect(parsePositiveInt('0', 5)).toBe(5)
    expect(parsePositiveInt('-3', 5)).toBe(5)
    expect(parsePositiveInt('abc', 5)).toBe(5)
  })

  it('marks truncation instead of silently cutting', () => {
    expect(truncateOutput('abcdef', 3)).toEqual({ content: 'abc', truncated: true })
    expect(truncateOutput('abc', 3)).toEqual({ content: 'abc', truncated: false })
    expect(truncateOutput(undefined)).toEqual({ content: '', truncated: false })
  })
})

describe('serializeEvaluation / normalizeWaitCondition', () => {
  it('keeps JSON-safe values and stringifies the rest', () => {
    expect(serializeEvaluation({ a: 1 })).toEqual({ a: 1 })
    expect(serializeEvaluation(undefined)).toBeNull()
    const cyclic = {}
    cyclic.self = cyclic
    expect(typeof serializeEvaluation(cyclic)).toBe('string')
  })

  it('treats an empty condition as「等页面加载完成」', () => {
    expect(normalizeWaitCondition({ selector: '#a' })).toEqual({
      selector: '#a',
      text: '',
      url: '',
      ready: false
    })
    expect(normalizeWaitCondition({})).toEqual({ selector: '', text: '', url: '', ready: true })
  })
})

describe('pickNetworkHeaders', () => {
  it('keeps custom headers and drops credentials', () => {
    const headers = pickNetworkHeaders({
      'nuwa-wings': 'env=osim149-v',
      'x-mica-owner': 'demo',
      cookie: 'ZUCHETOKEN=secret',
      Authorization: 'Bearer secret',
      accept: '*/*'
    })
    expect(headers['nuwa-wings']).toBe('env=osim149-v')
    expect(headers['x-mica-owner']).toBe('demo')
    expect(headers.accept).toBe('*/*')
    expect(headers.cookie).toBeUndefined()
    expect(headers.Authorization).toBeUndefined()
  })

  it('tolerates missing headers and truncates long values', () => {
    expect(pickNetworkHeaders(undefined)).toEqual({})
    expect(pickNetworkHeaders(null)).toEqual({})
    const long = pickNetworkHeaders({ 'x-long': 'a'.repeat(500) })['x-long']
    expect(long.endsWith('…')).toBe(true)
    expect(long.length).toBe(201)
  })
})

describe('keyDescriptors', () => {
  it('maps named keys and single characters', () => {
    expect(keyDescriptors(['Enter'])[0]).toMatchObject({ key: 'Enter', keyCode: 13 })
    expect(keyDescriptors('Escape')[0]).toMatchObject({ key: 'Escape' })
    expect(keyDescriptors(['a'])[0]).toMatchObject({ key: 'a', code: 'KeyA', text: 'a' })
    expect(keyDescriptors(['1'])[0]).toMatchObject({ key: '1', code: '', text: '1' })
  })

  it('refuses unknown keys and empty input rather than guessing', () => {
    expect(() => keyDescriptors(['F13'])).toThrow('不支持的按键：F13')
    expect(() => keyDescriptors([])).toThrow('keys 需要一个非空数组')
  })

  // 真实失败样例：模型按 Playwright 的印象写 `Meta+Shift+KeyB`，报错只回一句「不支持」
  // 它就会换个写法再猜一次。这里锁住的是报错里的取值清单与正确写法。
  it('teaches the accepted key names and the compact modifier spelling', () => {
    let message = ''
    try {
      keyDescriptors(['Meta+Shift+KeyB'])
    } catch (error) {
      message = error.message
    }

    expect(message).toContain('不支持的按键：Meta+Shift+KeyB')
    expect(message).toContain('Enter')
    expect(message).toContain('ArrowUp')
    expect(message).toContain('单个可打印字符')
    expect(message).toContain('"Meta+Shift+B"')
    expect(message).toContain('"Meta+Shift+KeyB"')
    expect(message).toContain('dispatchEvent')
    expect(message).toContain('不带 action')
  })
})

describe('BrowserRequestError', () => {
  it('carries a status code for the HTTP layer', () => {
    expect(new BrowserRequestError('nope', 404).status).toBe(404)
    expect(new BrowserRequestError('nope').status).toBe(400)
  })
})

describe('applyBrowserRenderSwitch', () => {
  // 隐藏窗口里 rAF 不跑、visibilityState 停在 hidden，截图只能拿到冻结的那一帧；
  // 这个开关是唯一有效的解，所以「默认挂上」必须被锁住。
  function fakeCommandLine() {
    const switches = []
    return { switches, appendSwitch: (name) => switches.push(name) }
  }

  it('is on by default (no env at all)', () => {
    const commandLine = fakeCommandLine()
    expect(browserUnthrottleEnabled({})).toBe(true)
    expect(applyBrowserRenderSwitch(commandLine, {})).toBe(true)
    expect(commandLine.switches).toEqual([BROWSER_UNTHROTTLE_SWITCH])
  })

  it('stays on for values that are not an explicit no', () => {
    const commandLine = fakeCommandLine()
    expect(applyBrowserRenderSwitch(commandLine, { MICA_BROWSER_UNTHROTTLE: 'maybe' })).toBe(true)
    expect(applyBrowserRenderSwitch(commandLine, { MICA_BROWSER_UNTHROTTLE: '1' })).toBe(true)
    expect(commandLine.switches).toEqual([BROWSER_UNTHROTTLE_SWITCH, BROWSER_UNTHROTTLE_SWITCH])
  })

  it('can be turned off explicitly, without appending anything', () => {
    for (const value of ['0', 'false', 'no', 'off', 'OFF']) {
      const commandLine = fakeCommandLine()
      expect(browserUnthrottleEnabled({ MICA_BROWSER_UNTHROTTLE: value })).toBe(false)
      expect(applyBrowserRenderSwitch(commandLine, { MICA_BROWSER_UNTHROTTLE: value })).toBe(false)
      expect(commandLine.switches).toEqual([])
    }
  })
})

describe('visibilityEventName', () => {
  // 「可见」只由用户点图标或显式演示改变：窗口自己的 show/hide 不该让图标乱闪
  it('only reports real transitions', () => {
    expect(visibilityEventName(false, true)).toBe('shown')
    expect(visibilityEventName(true, false)).toBe('hidden')
    expect(visibilityEventName(true, true)).toBeNull()
    expect(visibilityEventName(false, false)).toBeNull()
  })
})

describe('createTabSwitcher', () => {
  // 假窗口：只保留临界区真正依赖的 activeTabId / tabs，切换只改 activeTabId 并记账
  // （真实实现还动静 WebContentsView，那部分要 Electron，见 browser-manager.js）
  const makeSwitcher = () => {
    const events = []
    const activate = (record, tabId) => {
      record.activeTabId = tabId
      events.push(`activate:${tabId}`)
    }
    return { withTargetTab: createTabSwitcher(activate), events }
  }
  const makeRecord = (tabIds, activeId = tabIds[0]) => ({
    id: `brw-${tabIds.join('-')}`,
    activeTabId: activeId,
    tabs: tabIds.map((id) => ({ id }))
  })
  const deferred = () => {
    let resolve
    const promise = new Promise((done) => {
      resolve = done
    })
    return { promise, resolve }
  }
  // 等一段宏任务：此时该进的微任务都进完了，能看清「第二个 run 有没有开始」
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('runs one temporary tab switch at a time on the same window', async () => {
    const { withTargetTab, events } = makeSwitcher()
    const record = makeRecord(['tab-1', 'tab-2', 'tab-3'], 'tab-3')
    const gate = deferred()
    const first = withTargetTab(record, record.tabs[0], async () => {
      events.push(`first:${record.activeTabId}`)
      await gate.promise
      return 'first'
    })
    const second = withTargetTab(record, record.tabs[1], async () => {
      events.push(`second:${record.activeTabId}`)
      return 'second'
    })

    await flush()
    // 第一个还卡在 run 里时，第二个连临界区都没进（否则这里会多一条 activate:tab-2）
    expect(events).toEqual(['activate:tab-1', 'first:tab-1'])
    expect(record.activeTabId).toBe('tab-1')

    gate.resolve()
    expect(await Promise.all([first, second])).toEqual(['first', 'second'])
    // 第二个进来之前，第一个已经把自己切回了 tab-3；第二个恢复的也是它进临界区时看到的 tab-3
    expect(events).toEqual([
      'activate:tab-1',
      'first:tab-1',
      'activate:tab-3',
      'activate:tab-2',
      'second:tab-2',
      'activate:tab-3'
    ])
    expect(record.activeTabId).toBe('tab-3')
  })

  it('releases the queue and restores the tab when a run throws', async () => {
    const { withTargetTab, events } = makeSwitcher()
    const record = makeRecord(['tab-1', 'tab-2'])
    const failed = withTargetTab(record, record.tabs[1], async () => {
      throw new Error('页面里炸了')
    })
    // 排队在后面：前一个失败也必须能进临界区，且不重试
    const next = withTargetTab(record, record.tabs[0], async () => record.activeTabId)

    await expect(failed).rejects.toThrow('页面里炸了')
    expect(await next).toBe('tab-1')
    expect(record.activeTabId).toBe('tab-1')
    expect(events).toEqual(['activate:tab-2', 'activate:tab-1'])
  })

  it('does not serialize across windows', async () => {
    const { withTargetTab } = makeSwitcher()
    const slowRecord = makeRecord(['a-1', 'a-2'])
    const otherRecord = makeRecord(['b-1', 'b-2'])
    const gate = deferred()
    const held = withTargetTab(slowRecord, slowRecord.tabs[0], () => gate.promise)

    // 另一个窗口不等前一个：这条能直接跑完就说明队列是按 record 分的
    await expect(withTargetTab(otherRecord, otherRecord.tabs[1], async () => 'ok')).resolves.toBe(
      'ok'
    )
    expect(otherRecord.activeTabId).toBe('b-1')

    gate.resolve()
    await held
  })
})
