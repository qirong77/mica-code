import { describe, expect, it } from 'bun:test'
import {
  APP_PAGE_PATHS,
  appPageKey,
  appPagePath,
  isAppPageTarget,
  relayEntryKey
} from './app-page-target.js'

describe('isAppPageTarget', () => {
  const origins = ['http://127.0.0.1:8787']

  it('accepts the files page the folder button opens', () => {
    // 顶栏的编辑器按钮就是 `window.open('/files?cwd=…')`：它得由外壳开成应用窗口
    expect(isAppPageTarget('http://127.0.0.1:8787/files?cwd=%2Fw', { origins })).toBe(true)
  })

  it('accepts the main page with any query string', () => {
    expect(isAppPageTarget('http://127.0.0.1:8787/?session=a', { origins })).toBe(true)
    expect(isAppPageTarget('http://127.0.0.1:8787/mica-web', { origins })).toBe(true)
  })

  it('accepts the dev page served by Vite', () => {
    expect(
      isAppPageTarget('http://localhost:5173/files.html?cwd=%2Fw', {
        origins: ['http://localhost:5173']
      })
    ).toBe(true)
  })

  it('rejects paths that are not application pages', () => {
    // 终端控制窗口有自己的入口，受控浏览器的代理端点也不是页面
    expect(isAppPageTarget('http://127.0.0.1:8787/terminal-control', { origins })).toBe(false)
    expect(isAppPageTarget('http://127.0.0.1:8787/remote/control/tabs', { origins })).toBe(false)
    expect(isAppPageTarget('http://127.0.0.1:8787/api/invoke', { origins })).toBe(false)
  })

  it('rejects another server', () => {
    expect(isAppPageTarget('http://127.0.0.1:8899/files', { origins })).toBe(false)
  })

  it('rejects anything that is not an http(s) address', () => {
    expect(isAppPageTarget('', { origins })).toBe(false)
    expect(isAppPageTarget('not a url', { origins })).toBe(false)
    expect(isAppPageTarget('file:///tmp/x.html', { origins })).toBe(false)
    expect(isAppPageTarget(undefined, { origins })).toBe(false)
  })

  it('treats a missing origin list as "nothing matches"', () => {
    expect(isAppPageTarget('http://127.0.0.1:8787/files')).toBe(false)
  })
})

describe('appPagePath', () => {
  it('treats the dev page and the runtime route as the same page', () => {
    expect(appPagePath('/files.html')).toBe('/files')
    expect(appPagePath('http://h:1/files?cwd=%2Fw')).toBe('/files')
  })

  it('collapses the service prefix and the index page', () => {
    expect(appPagePath('/mica-web')).toBe('/')
    expect(appPagePath('/mica-web/')).toBe('/')
    expect(appPagePath('/index.html')).toBe('/')
    expect(appPagePath('/')).toBe('/')
  })

  it('leaves other paths alone', () => {
    expect(appPagePath('/terminal-control')).toBe('/terminal-control')
    expect(appPagePath('/share')).toBe('/share')
  })

  it('knows exactly which pages can be opened as windows', () => {
    expect(APP_PAGE_PATHS).toContain('/')
    expect(APP_PAGE_PATHS).toContain('/files')
  })
})

describe('appPageKey', () => {
  it('ignores the hash and a trailing slash', () => {
    expect(appPageKey('http://h:1/files?cwd=%2Fw#x')).toBe('http://h:1/files?cwd=%2Fw')
    expect(appPageKey('http://h:1/mica-web/')).toBe(appPageKey('http://h:1/mica-web'))
  })

  it('keeps the query, so two directories stay different window contents', () => {
    expect(appPageKey('http://h:1/files?cwd=%2Fa')).not.toBe(
      appPageKey('http://h:1/files?cwd=%2Fb')
    )
  })

  it('returns an empty key for an unparsable address', () => {
    expect(appPageKey('')).toBe('')
    expect(appPageKey(undefined)).toBe('')
  })
})

describe('relayEntryKey', () => {
  it('keys a relay entry by origin plus token', () => {
    expect(relayEntryKey('https://r.example/?t=abc&session=s1')).toBe('https://r.example?t=abc')
  })

  it('treats two machines behind one relay as two windows', () => {
    // 同一台中转机后面可以是两台机器：只按 origin 认窗口会「点 B 却端出 A」
    expect(relayEntryKey('https://r.example/?t=abc')).not.toBe(
      relayEntryKey('https://r.example/?t=def')
    )
  })

  it('folds different sessions of the same machine into one window', () => {
    expect(relayEntryKey('https://r.example/?t=abc&session=s1')).toBe(
      relayEntryKey('https://r.example/?t=abc&session=s2')
    )
  })

  it('has no key for a plain runtime address', () => {
    // 直连的机器仍然按 origin 认窗口
    expect(relayEntryKey('http://192.168.1.5:8787')).toBe('')
    expect(relayEntryKey('http://192.168.1.5:8787/?session=s1')).toBe('')
    expect(relayEntryKey('')).toBe('')
  })
})
