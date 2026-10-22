import { describe, expect, it } from 'bun:test'
import { appPageKey, isAppPageTarget } from './app-page-target.js'

describe('isAppPageTarget', () => {
  const origins = ['http://127.0.0.1:8787']

  it('accepts the same page with a different query string', () => {
    // 页面点文件夹就是这个形状：同一个应用页面 + `?view=files`
    expect(
      isAppPageTarget('http://127.0.0.1:8787/?session=a&view=files', { origins, page: '/' })
    ).toBe(true)
    expect(
      isAppPageTarget('http://127.0.0.1:8787/mica-web?view=files', {
        origins,
        page: 'http://127.0.0.1:8787/mica-web?session=a'
      })
    ).toBe(true)
  })

  it('rejects another path on the same server', () => {
    // 终端控制窗口、受控浏览器的代理端点不是「应用页面」
    expect(
      isAppPageTarget('http://127.0.0.1:8787/terminal-control?session=a', { origins, page: '/' })
    ).toBe(false)
    expect(
      isAppPageTarget('http://127.0.0.1:8787/remote/control/tabs', { origins, page: '/' })
    ).toBe(false)
  })

  it('rejects another server', () => {
    expect(isAppPageTarget('http://127.0.0.1:8899/?view=files', { origins, page: '/' })).toBe(false)
  })

  it('rejects anything that is not an http(s) address', () => {
    expect(isAppPageTarget('', { origins, page: '/' })).toBe(false)
    expect(isAppPageTarget('not a url', { origins, page: '/' })).toBe(false)
    expect(isAppPageTarget('file:///tmp/x.html', { origins, page: '/' })).toBe(false)
    expect(isAppPageTarget(undefined, { origins, page: '/' })).toBe(false)
  })

  it('treats a missing origin list as "nothing matches"', () => {
    expect(isAppPageTarget('http://127.0.0.1:8787/?view=files', { page: '/' })).toBe(false)
  })
})

describe('appPageKey', () => {
  it('ignores the hash and a trailing slash', () => {
    expect(appPageKey('http://h:1/?view=files#x')).toBe('http://h:1/?view=files')
    expect(appPageKey('http://h:1/mica-web/')).toBe(appPageKey('http://h:1/mica-web'))
  })

  it('keeps the query, so two views stay different windows', () => {
    expect(appPageKey('http://h:1/?view=files')).not.toBe(appPageKey('http://h:1/?view=chat'))
  })

  it('returns an empty key for an unparsable address', () => {
    expect(appPageKey('')).toBe('')
    expect(appPageKey(undefined)).toBe('')
  })
})
