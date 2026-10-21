import { describe, expect, test } from 'bun:test'
import {
  browserControlTargetPath,
  describeSocketError,
  isBrowserControlPath,
  proxyRequestHeaders,
  proxyResponseHeaders
} from './browser-control-proxy'
import { isTerminalControlPath, terminalControlTargetPath } from './terminal-control-proxy'

describe('control proxy routing', () => {
  test('explains a missing socket instead of blaming the wrong host', () => {
    const missing = describeSocketError(
      Object.assign(new Error('connect ENOENT /tmp/x.sock'), { code: 'ENOENT' }),
      '受控浏览器服务',
      '/tmp/x.sock'
    )
    expect(missing).toContain('/tmp/x.sock 不存在')
    expect(missing).toContain('重启')

    const stale = describeSocketError(
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
      '终端控制服务',
      '/tmp/y.sock'
    )
    expect(stale).toContain('没人监听')

    const other = describeSocketError(new Error('boom'), '受控浏览器服务', '/tmp/z.sock')
    expect(other).toBe('受控浏览器服务不可用：boom')
  })

  test('matches the prefix itself and everything under it', () => {
    expect(isBrowserControlPath('/remote/control')).toBe(true)
    expect(isBrowserControlPath('/remote/control/browser/tabs')).toBe(true)
    expect(isBrowserControlPath('/remote/controls')).toBe(false)
    expect(isBrowserControlPath('/api/env')).toBe(false)
  })

  test('strips the prefix and keeps the query', () => {
    expect(browserControlTargetPath('/remote/control/browser/events', '?since=3')).toBe(
      '/browser/events?since=3'
    )
    expect(browserControlTargetPath('/remote/control')).toBe('/')
    expect(browserControlTargetPath('/api/env')).toBeNull()
  })

  test('terminal control reuses the same helpers with its own prefix', () => {
    expect(isTerminalControlPath('/remote/terminal/sessions')).toBe(true)
    expect(isTerminalControlPath('/remote/terminals')).toBe(false)
    // 端点相对服务根：`$MICA_TERMINAL_URL/sessions` 必须落到 `/sessions`
    expect(terminalControlTargetPath('/remote/terminal/sessions')).toBe('/sessions')
    expect(terminalControlTargetPath('/remote/terminal/events', '?since=1')).toBe('/events?since=1')
  })
})

describe('proxy headers', () => {
  test('rewrites Host to loopback and drops the browser Origin', () => {
    const headers = proxyRequestHeaders({
      host: '192.168.1.20:8787',
      origin: 'http://192.168.1.20:8787',
      'content-type': 'application/json',
      connection: 'keep-alive'
    })
    expect(headers.host).toBe('127.0.0.1')
    // 运行时入口已校验来源；透传局域网 Origin 会被主进程当成跨站请求
    expect(headers.origin).toBeUndefined()
    expect(headers['content-type']).toBe('application/json')
    expect(headers.connection).toBeUndefined()
  })

  test('drops hop-by-hop headers on the way back', () => {
    const headers = proxyResponseHeaders({
      'content-type': 'application/json',
      'transfer-encoding': 'chunked',
      'cache-control': 'no-store'
    })
    expect(headers['content-type']).toBe('application/json')
    expect(headers['cache-control']).toBe('no-store')
    expect(headers['transfer-encoding']).toBeUndefined()
  })
})
