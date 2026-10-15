import { describe, expect, it } from 'bun:test'
import {
  BROWSER_OWNER_ENV,
  BROWSER_URL_ENV,
  detailsFrom,
  emptyBrowserSnapshot,
  normalizeBrowserSummaries,
  parseSseData,
  sameBrowsers,
  skillFilePath,
  skillNeedsWrite
} from './browser-control-core.js'

describe('normalizeBrowserSummaries', () => {
  it('keeps the fields the UI uses and defaults the rest', () => {
    const [browser] = normalizeBrowserSummaries([
      {
        id: 'brw-1',
        owner: 'sess-1',
        label: '订单页',
        title: '订单',
        url: 'https://example.com',
        visible: true,
        loading: false,
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1', title: '订单', url: 'https://example.com', active: true }]
      }
    ])
    expect(browser).toEqual({
      id: 'brw-1',
      owner: 'sess-1',
      label: '订单页',
      title: '订单',
      url: 'https://example.com',
      visible: true,
      loading: false,
      activeTabId: 'tab-1',
      tabs: [{ id: 'tab-1', title: '订单', url: 'https://example.com', active: true }]
    })
  })

  it('survives missing fields, junk entries and a non-array payload', () => {
    expect(normalizeBrowserSummaries(null)).toEqual([])
    expect(normalizeBrowserSummaries('nope')).toEqual([])
    const [browser] = normalizeBrowserSummaries([{ id: 'brw-1' }, null, 'x'])
    expect(browser).toMatchObject({
      id: 'brw-1',
      owner: null,
      label: '',
      url: '',
      visible: false,
      activeTabId: null,
      tabs: []
    })
    expect(normalizeBrowserSummaries([{ owner: 'no-id' }])).toEqual([])
  })
})

describe('skill file', () => {
  it('writes under $MICA_HOME/skills/mica-browser', () => {
    expect(skillFilePath('/home/u/.mica')).toBe('/home/u/.mica/skills/mica-browser/SKILL.md')
    expect(skillFilePath('C:\\Users\\u\\.mica', '\\')).toBe(
      'C:\\Users\\u\\.mica\\skills\\mica-browser\\SKILL.md'
    )
  })

  it('rewrites only when the content actually changed', () => {
    expect(skillNeedsWrite(null, '# doc')).toBe(true)
    expect(skillNeedsWrite('# doc', '# doc')).toBe(false)
    expect(skillNeedsWrite('# doc', '# doc\n')).toBe(true)
    // 空内容不写：宁可不写，也不要把用户的技能文件清成空的
    expect(skillNeedsWrite('# doc', '')).toBe(false)
    expect(skillNeedsWrite('# doc', undefined)).toBe(false)
  })
})

describe('detailsFrom', () => {
  it('assembles the settings page payload', () => {
    const details = detailsFrom({
      docs: { version: 3, endpoints: [{ id: 'health' }], markdown: 'md', skillMarkdown: 'skill' },
      browsers: [{ id: 'brw-1', owner: 'sess-1' }],
      serviceUrl: 'http://127.0.0.1:18767',
      skillPath: '/home/u/.mica/skills/mica-browser/SKILL.md'
    })
    expect(details).toMatchObject({
      available: true,
      serviceUrl: 'http://127.0.0.1:18767',
      version: 3,
      skillPath: '/home/u/.mica/skills/mica-browser/SKILL.md',
      error: null,
      envVars: { url: BROWSER_URL_ENV, owner: BROWSER_OWNER_ENV }
    })
    expect(details.endpoints).toHaveLength(1)
    expect(details.browsers[0].id).toBe('brw-1')
  })

  it('reports unavailable without a service url and tolerates missing docs', () => {
    const details = detailsFrom({ docs: null, browsers: [], serviceUrl: '' })
    expect(details.available).toBe(false)
    expect(details.serviceUrl).toBeNull()
    expect(details.version).toBe(0)
    expect(details.endpoints).toEqual([])
    expect(details.markdown).toBe('')
  })
})

describe('emptyBrowserSnapshot / sameBrowsers / parseSseData', () => {
  it('starts from an empty, unavailable snapshot', () => {
    expect(emptyBrowserSnapshot()).toEqual({
      available: false,
      serviceUrl: null,
      browsers: [],
      skillPath: null,
      error: null
    })
    expect(emptyBrowserSnapshot('boom').error).toBe('boom')
  })

  it('compares browser lists structurally', () => {
    expect(sameBrowsers([{ id: 'a' }], [{ id: 'a' }])).toBe(true)
    expect(sameBrowsers([{ id: 'a' }], [{ id: 'b' }])).toBe(false)
    expect(sameBrowsers(null, [])).toBe(true)
  })

  it('parses our own SSE frames only', () => {
    expect(parseSseData('data: {"channel":"browser:changed","payload":{"browsers":[]}}')).toEqual({
      channel: 'browser:changed',
      payload: { browsers: [] }
    })
    expect(parseSseData(': ping')).toBeNull()
    expect(parseSseData('data: not-json')).toBeNull()
    expect(parseSseData('data: {"payload":{}}')).toBeNull()
    expect(parseSseData(null)).toBeNull()
  })
})
