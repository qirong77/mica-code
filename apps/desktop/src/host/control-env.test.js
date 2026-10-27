import { describe, expect, test } from 'bun:test'
import { stripControlSockets } from './control-env'

/**
 * 会话进程的环境：只留「怎么访问运行时」，不留「怎么绕过运行时」。
 * socket 是运行时内部通道，留在子进程里等于跳过运行时的 Host/Origin 校验。
 */
describe('stripControlSockets', () => {
  test('drops the internal sockets but keeps the runtime addresses', () => {
    const env = stripControlSockets({
      PATH: '/usr/bin',
      MICA_TERMINAL_URL: 'http://127.0.0.1:8787/remote/terminal',
      MICA_TERMINAL_SOCKET: '/tmp/mica-terminal.sock',
      MICA_BROWSER_URL: 'http://127.0.0.1:8787/remote/control',
      MICA_BROWSER_SOCKET: '/tmp/mica-browser.sock',
      MICA_SYSTEM_SOCKET: '/tmp/mica-system.sock'
    })

    expect(env).toEqual({
      PATH: '/usr/bin',
      MICA_TERMINAL_URL: 'http://127.0.0.1:8787/remote/terminal',
      MICA_BROWSER_URL: 'http://127.0.0.1:8787/remote/control'
    })
  })

  test('drops the system check socket too', () => {
    expect(stripControlSockets({ MICA_SYSTEM_SOCKET: '/tmp/mica-system.sock' })).toEqual({})
  })

  test('does not mutate the caller environment', () => {
    const source = { MICA_TERMINAL_SOCKET: '/tmp/x.sock' }
    stripControlSockets(source)
    expect(source.MICA_TERMINAL_SOCKET).toBe('/tmp/x.sock')
  })
})
