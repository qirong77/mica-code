import { describe, expect, it } from 'bun:test'
import {
  BrowserRequestError,
  browserSummary,
  compileRoutes,
  formatCookieHeader,
  keyDescriptors,
  matchPath,
  normalizeOwner,
  normalizeUrl,
  normalizeWaitCondition,
  parseBoolean,
  parsePositiveInt,
  publicCookie,
  resolveOwner,
  resolveRoute,
  serializeEvaluation,
  sortCookiesForHeader,
  tabSummary,
  truncateOutput
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

  it('requires at least one wait condition', () => {
    expect(normalizeWaitCondition({ selector: '#a' })).toEqual({
      selector: '#a',
      text: '',
      url: ''
    })
    expect(() => normalizeWaitCondition({})).toThrow('wait 需要 selector、text 或 url 之一')
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
})

describe('BrowserRequestError', () => {
  it('carries a status code for the HTTP layer', () => {
    expect(new BrowserRequestError('nope', 404).status).toBe(404)
    expect(new BrowserRequestError('nope').status).toBe(400)
  })
})
