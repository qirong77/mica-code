import { describe, expect, it } from 'bun:test'
import {
  hostAllowed,
  hostnameOf,
  isLoopbackAddress,
  isPrivateLanAddress,
  pickShareBaseUrl,
  sameSiteOriginAllowed
} from './access-core'

describe('isLoopbackAddress', () => {
  it('treats 127.0.0.0/8 and ::1 as local, including the IPv4-mapped form', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.9.9.9')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    // 双栈 socket 上 Node 会把本机 IPv4 报成这个形式，漏了它就会把本机请求当成远程
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
  })

  it('rejects everything else', () => {
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
    expect(isLoopbackAddress('10.0.0.1')).toBe(false)
    expect(isLoopbackAddress('::ffff:192.168.1.5')).toBe(false)
    expect(isLoopbackAddress('')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
    // 不是「以 127 开头」的字符串就算，必须是完整 IP
    expect(isLoopbackAddress('1270.0.0.1')).toBe(false)
    expect(isLoopbackAddress('127.0.0.1.evil.com')).toBe(false)
  })
})

describe('isPrivateLanAddress', () => {
  it('matches the three RFC1918 ranges', () => {
    expect(isPrivateLanAddress('10.0.0.5')).toBe(true)
    expect(isPrivateLanAddress('192.168.1.9')).toBe(true)
    expect(isPrivateLanAddress('172.16.0.1')).toBe(true)
    expect(isPrivateLanAddress('172.31.255.254')).toBe(true)
    expect(isPrivateLanAddress('172.15.0.1')).toBe(false)
    expect(isPrivateLanAddress('172.32.0.1')).toBe(false)
    expect(isPrivateLanAddress('8.8.8.8')).toBe(false)
  })
})

describe('hostnameOf / hostAllowed', () => {
  it('strips the port, keeping IPv6 brackets', () => {
    expect(hostnameOf('127.0.0.1:8787')).toBe('127.0.0.1')
    expect(hostnameOf('HOST.example:1')).toBe('host.example')
    expect(hostnameOf('[::1]:8787')).toBe('[::1]')
    expect(hostnameOf('localhost')).toBe('localhost')
  })

  it('accepts loopback hosts and known names, rejects a rebinding domain', () => {
    const allowed = new Set([
      'localhost',
      '127.0.0.1',
      '::1',
      '[::1]',
      'mac-mini.local',
      '192.168.1.5'
    ])
    expect(hostAllowed('127.0.0.1:8787', allowed)).toBe(true)
    expect(hostAllowed('mac-mini.local:8787', allowed)).toBe(true)
    expect(hostAllowed('192.168.1.5', allowed)).toBe(true)
    // DNS rebinding：攻击者域名解析到 127.0.0.1，浏览器发来的 Host 是他自己的域名
    expect(hostAllowed('evil.example:8787', allowed)).toBe(false)
    expect(hostAllowed('', allowed)).toBe(false)
  })
})

describe('sameSiteOriginAllowed', () => {
  const names = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'mac-mini.local', '192.168.1.9'])

  it('allows same-origin and origin-less requests, rejects cross-origin and null', () => {
    expect(sameSiteOriginAllowed('http://127.0.0.1:8787', '127.0.0.1:8787', names)).toBe(true)
    expect(sameSiteOriginAllowed('http://mac-mini.local:8787', 'mac-mini.local:8787', names)).toBe(
      true
    )
    // curl / 脚本 / SSE 重连不带 Origin
    expect(sameSiteOriginAllowed('', '127.0.0.1:8787', names)).toBe(true)
    expect(sameSiteOriginAllowed(undefined, '127.0.0.1:8787', names)).toBe(true)
    // 任意网页对着 127.0.0.1:8787 发请求时就是这个形状
    expect(sameSiteOriginAllowed('https://evil.example', '127.0.0.1:8787', names)).toBe(false)
    expect(sameSiteOriginAllowed('https://evil.example:9999', '127.0.0.1:8787', names)).toBe(false)
    // 本机其它端口的页面（另一个本地 dev server）算同站：能起本地服务就已经在本机执行代码了
    expect(sameSiteOriginAllowed('http://127.0.0.1:9999', '127.0.0.1:8787', names)).toBe(true)
    // 沙箱 iframe / file:// 会给出 "null"，解析不了就必须拒绝
    expect(sameSiteOriginAllowed('null', '127.0.0.1:8787', names)).toBe(false)
  })

  it('allows the vite dev proxy, where the page port differs from the runtime port', () => {
    // npm run dev：页面在 localhost:5173，/api 反代到运行时，两边 host:port 不同但同站
    expect(sameSiteOriginAllowed('http://localhost:5173', '127.0.0.1:8799', names)).toBe(true)
    expect(sameSiteOriginAllowed('http://localhost:5173', '172.22.240.72:8799', names)).toBe(true)
    // 局域网里的开发页（页面跑在另一台机器上时）
    expect(sameSiteOriginAllowed('http://192.168.1.9:5173', '192.168.1.9:8799', names)).toBe(true)
    // 但外部站点拿不到这条通道
    expect(sameSiteOriginAllowed('http://evil.example:5173', '127.0.0.1:8799', names)).toBe(false)
    expect(
      sameSiteOriginAllowed('http://192.168.1.9.evil.example', '192.168.1.9:8799', names)
    ).toBe(false)
  })

  it('rejects a same-site origin when no hostname list is supplied', () => {
    expect(sameSiteOriginAllowed('http://192.168.1.9:5173', '192.168.1.9:8799', undefined)).toBe(
      false
    )
    // 回环名不依赖调用方传参
    expect(sameSiteOriginAllowed('http://localhost:5173', '127.0.0.1:8799', undefined)).toBe(true)
  })
})

describe('pickShareBaseUrl', () => {
  const lan = [{ address: '192.168.1.23', internal: false }]

  it('prefers the pinned public url and keeps its scheme', () => {
    expect(
      pickShareBaseUrl({ publicUrl: 'https://mica.example.com/', sharePort: 8788, addresses: lan })
    ).toBe('https://mica.example.com')
    // 认不出来的 public url 退回网卡地址，而不是给出一条坏链接
    expect(pickShareBaseUrl({ publicUrl: 'not a url', sharePort: 8788, addresses: lan })).toBe(
      'http://192.168.1.23:8788'
    )
  })

  it('prefers the address the sharer is already using, when it is one of ours', () => {
    const allowed = new Set(['192.168.1.23'])
    expect(
      pickShareBaseUrl({
        sharePort: 8788,
        addresses: [{ address: '172.17.0.1' }],
        // 分享者自己是从主端口（8787）打开页面的，但链接必须落在分享端口上
        preferredOrigin: 'http://192.168.1.23:8787',
        allowedHostnames: allowed
      })
    ).toBe('http://192.168.1.23:8788')
    // docker0 那种别的机器连不到的网卡不会被优先选中
    expect(
      pickShareBaseUrl({
        sharePort: 8788,
        addresses: lan,
        preferredOrigin: 'http://172.17.0.1:8787',
        allowedHostnames: allowed
      })
    ).toBe('http://192.168.1.23:8788')
    // 不在白名单里的地址（对方发来的链接之类）也不认
    expect(
      pickShareBaseUrl({
        sharePort: 8788,
        addresses: lan,
        preferredOrigin: 'http://10.0.0.9:8787',
        allowedHostnames: allowed
      })
    ).toBe('http://192.168.1.23:8788')
  })

  it('ranks private lan over public ipv4 over ipv6, and drops link-local', () => {
    expect(
      pickShareBaseUrl({
        sharePort: 8788,
        addresses: [{ address: '8.8.8.8' }, { address: 'fe80::1' }, { address: '192.168.1.23' }]
      })
    ).toBe('http://192.168.1.23:8788')
    expect(pickShareBaseUrl({ sharePort: 8788, addresses: [{ address: '8.8.8.8' }] })).toBe(
      'http://8.8.8.8:8788'
    )
    // IPv6 要带方括号，否则拼出来的地址解析不了
    expect(pickShareBaseUrl({ sharePort: 8788, addresses: [{ address: 'fd00::2' }] })).toBe(
      'http://[fd00::2]:8788'
    )
  })

  it('returns null when only loopback is available, or the share port is off', () => {
    expect(pickShareBaseUrl({ sharePort: 8788, addresses: [{ address: '127.0.0.1' }] })).toBeNull()
    expect(
      pickShareBaseUrl({
        sharePort: 8788,
        addresses: [{ address: '192.168.1.23', internal: true }]
      })
    ).toBeNull()
    expect(pickShareBaseUrl({ addresses: lan })).toBeNull()
    expect(pickShareBaseUrl()).toBeNull()
    // 分享端口被关掉（0）时没有分享地址，而不是退回主端口
    expect(pickShareBaseUrl({ sharePort: 0, addresses: lan })).toBeNull()
  })
})
