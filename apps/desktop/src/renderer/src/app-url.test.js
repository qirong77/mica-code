import { describe, expect, it } from 'bun:test'
import {
  detachedFilesUrl,
  readAppUrl,
  readFilesUrl,
  sessionShareUrl,
  urlWithState
} from './app-url'

describe('readAppUrl', () => {
  it('reads the open session', () => {
    expect(readAppUrl('?session=abc')).toEqual({ sessionId: 'abc' })
  })

  it('falls back when the param is missing or blank', () => {
    expect(readAppUrl('')).toEqual({ sessionId: null })
    expect(readAppUrl(undefined)).toEqual({ sessionId: null })
    expect(readAppUrl('?session=')).toEqual({ sessionId: null })
    expect(readAppUrl('?session=%20')).toEqual({ sessionId: null })
  })

  it('ignores anything a visitor might add by hand', () => {
    // 页面自己带进来的参数不具备任何含义，服务端才是判定方
    expect(readAppUrl('?session=abc&share=1')).toEqual({ sessionId: 'abc' })
  })
})

describe('urlWithState', () => {
  it('writes the session and keeps unrelated params', () => {
    expect(urlWithState('http://127.0.0.1:8787/?layout=mobile', { sessionId: 'a' })).toBe(
      'http://127.0.0.1:8787/?layout=mobile&session=a'
    )
  })

  it('replaces an existing session', () => {
    expect(urlWithState('http://h:1/?session=old', { sessionId: 'new' })).toBe(
      'http://h:1/?session=new'
    )
  })

  it('drops the param when there is no session', () => {
    expect(urlWithState('http://h:1/?session=old&layout=desktop', { sessionId: null })).toBe(
      'http://h:1/?layout=desktop'
    )
  })

  it('returns null for an unparsable href', () => {
    expect(urlWithState('not a url', { sessionId: 'a' })).toBeNull()
  })
})

describe('detachedFilesUrl', () => {
  it('points at the runtime files page and carries the cwd', () => {
    expect(detachedFilesUrl('http://127.0.0.1:8787/?session=a', '/work/proj')).toBe(
      'http://127.0.0.1:8787/files?cwd=%2Fwork%2Fproj'
    )
  })

  it('uses the dev page when the main page is served by Vite', () => {
    // dev 下主页面是 Vite 的 /index.html，独立页也就得走 /files.html
    expect(detachedFilesUrl('http://localhost:5173/index.html?session=a', '/work')).toBe(
      'http://localhost:5173/files.html?cwd=%2Fwork'
    )
  })

  it('drops the main page params, so the window is not asked to open a chat', () => {
    expect(detachedFilesUrl('http://h:1/?session=a&layout=mobile#x', null)).toBe('http://h:1/files')
  })

  it('keeps a remote origin, so the window talks to the same runtime', () => {
    expect(detachedFilesUrl('http://192.168.1.23:8787/?session=a', '/w')).toStartWith(
      'http://192.168.1.23:8787/files?'
    )
  })

  it('returns null for an unparsable href', () => {
    expect(detachedFilesUrl('not a url', '/w')).toBeNull()
  })
})

describe('readFilesUrl', () => {
  it('reads the directory to show', () => {
    expect(readFilesUrl('?cwd=%2Fwork%2Fproj')).toEqual({ cwd: '/work/proj' })
  })

  it('falls back to an empty directory', () => {
    expect(readFilesUrl('')).toEqual({ cwd: null })
    expect(readFilesUrl('?cwd=')).toEqual({ cwd: null })
    expect(readFilesUrl('?cwd=%20')).toEqual({ cwd: null })
  })

  it('survives the round trip from detachedFilesUrl', () => {
    const url = detachedFilesUrl('http://h:1/?session=a', '/work/proj')
    expect(readFilesUrl(new URL(url).search)).toEqual({ cwd: '/work/proj' })
  })
})

describe('sessionShareUrl', () => {
  it('carries the session and nothing else', () => {
    // 链接只是「打开这条会话」的地址：没有令牌，也没有片段
    expect(sessionShareUrl('http://192.168.1.23:8787', 'abc')).toBe(
      'http://192.168.1.23:8787/?session=abc'
    )
  })

  it('uses the address given by the runtime, not the page origin', () => {
    // 本机窗口的 origin 是 127.0.0.1，发给别人等于让他连自己的机器，所以基地址来自运行时
    expect(sessionShareUrl('http://10.0.0.5:9000', 'abc')).toStartWith('http://10.0.0.5:9000/')
  })

  it('keeps an https public address intact', () => {
    expect(sessionShareUrl('https://mica.example.com', 'abc')).toBe(
      'https://mica.example.com/?session=abc'
    )
  })

  it('drops the base url query and hash', () => {
    expect(sessionShareUrl('http://h:1/?layout=mobile#x', 'abc')).toBe('http://h:1/?session=abc')
  })

  it('returns null without a session or a usable base url', () => {
    expect(sessionShareUrl('http://h:1', null)).toBeNull()
    expect(sessionShareUrl(null, 'abc')).toBeNull()
    expect(sessionShareUrl('not a url', 'abc')).toBeNull()
  })
})
