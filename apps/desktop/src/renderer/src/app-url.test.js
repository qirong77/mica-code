import { describe, expect, it } from 'bun:test'
import { readAppUrl, readFragmentToken, sessionShareUrl, urlWithState } from './app-url'

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
    // 客户端写进来的标记不具备任何授权含义，服务端才是判定方
    expect(readAppUrl('?session=abc&share=1&scope=full')).toEqual({ sessionId: 'abc' })
  })
})

describe('readFragmentToken', () => {
  it('reads #token=…', () => {
    expect(readFragmentToken('#token=abc')).toBe('abc')
    expect(readFragmentToken('token=abc')).toBe('abc')
    expect(readFragmentToken('#a=1&token=abc')).toBe('abc')
  })

  it('returns null when absent or blank', () => {
    expect(readFragmentToken('')).toBeNull()
    expect(readFragmentToken('#')).toBeNull()
    expect(readFragmentToken('#token=')).toBeNull()
    expect(readFragmentToken('#layout=mobile')).toBeNull()
    expect(readFragmentToken(undefined)).toBeNull()
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

describe('sessionShareUrl', () => {
  it('puts the session in the query and the token in the fragment', () => {
    expect(sessionShareUrl('http://192.168.1.23:8787', 'abc', 'tok')).toBe(
      'http://192.168.1.23:8787/?session=abc#token=tok'
    )
  })

  it('uses the address given by the runtime, not the page origin', () => {
    // 本机窗口的 origin 是 127.0.0.1，发给别人等于让他连自己的机器，所以基地址来自运行时
    expect(sessionShareUrl('http://10.0.0.5:9000', 'abc', 'tok')).toStartWith(
      'http://10.0.0.5:9000/'
    )
  })

  it('keeps an https public address intact', () => {
    expect(sessionShareUrl('https://mica.example.com', 'abc', 'tok')).toBe(
      'https://mica.example.com/?session=abc#token=tok'
    )
  })

  it('drops the base url query and hash', () => {
    expect(sessionShareUrl('http://h:1/?layout=mobile#x', 'abc', 'tok')).toBe(
      'http://h:1/?session=abc#token=tok'
    )
  })

  it('returns null without a session or a token', () => {
    expect(sessionShareUrl('http://h:1', null, 'tok')).toBeNull()
    expect(sessionShareUrl('http://h:1', 'abc', null)).toBeNull()
    expect(sessionShareUrl(null, 'abc', 'tok')).toBeNull()
  })
})
