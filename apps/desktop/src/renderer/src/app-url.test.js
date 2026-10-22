import { describe, expect, it } from 'bun:test'
import { readAppUrl, sessionShareUrl, urlWithState } from './app-url'

describe('readAppUrl', () => {
  it('reads the open session', () => {
    expect(readAppUrl('?session=abc')).toEqual({ sessionId: 'abc', view: null })
  })

  it('falls back when the param is missing or blank', () => {
    expect(readAppUrl('')).toEqual({ sessionId: null, view: null })
    expect(readAppUrl(undefined)).toEqual({ sessionId: null, view: null })
    expect(readAppUrl('?session=')).toEqual({ sessionId: null, view: null })
    expect(readAppUrl('?session=%20')).toEqual({ sessionId: null, view: null })
  })

  it('ignores anything a visitor might add by hand', () => {
    // 页面自己带进来的参数不具备任何含义，服务端才是判定方
    expect(readAppUrl('?session=abc&share=1')).toEqual({ sessionId: 'abc', view: null })
  })

  it('reads the view pinned by a detached window', () => {
    // 顶栏文件夹开出来的那个窗口：地址里带着 `?view=files`
    expect(readAppUrl('?session=abc&view=files')).toEqual({ sessionId: 'abc', view: 'files' })
  })

  it('drops a view it does not know', () => {
    expect(readAppUrl('?view=nope').view).toBeNull()
    expect(readAppUrl('?view=').view).toBeNull()
    expect(readAppUrl('?view=Files').view).toBeNull()
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

  it('writes and drops the view', () => {
    expect(urlWithState('http://h:1/?session=a', { view: 'files' })).toBe(
      'http://h:1/?session=a&view=files'
    )
    expect(urlWithState('http://h:1/?session=a&view=files', { view: null })).toBe(
      'http://h:1/?session=a'
    )
  })

  it('leaves the params it was not asked about alone', () => {
    // 切会话不该抹掉 `?view=`，反过来说文件窗口刷新视图也不该丢掉会话
    expect(urlWithState('http://h:1/?view=files', { sessionId: 'a' })).toBe(
      'http://h:1/?view=files&session=a'
    )
    expect(urlWithState('http://h:1/?session=a', {})).toBe('http://h:1/?session=a')
  })

  it('returns null for an unparsable href', () => {
    expect(urlWithState('not a url', { sessionId: 'a' })).toBeNull()
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
