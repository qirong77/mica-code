import { describe, expect, it } from 'bun:test'
import {
  hostAllowed,
  hostnameOf,
  isLoopbackAddress,
  isPrivateLanAddress,
  isTrustedClientAddress,
  pickShareBaseUrl,
  remoteRequestAllowed,
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

describe('isTrustedClientAddress', () => {
  it('matches exact addresses, IPv4-mapped forms and a last-octet wildcard', () => {
    const trusted = new Set(['172.22.240.5', '10.0.0.*'])
    expect(isTrustedClientAddress('172.22.240.5', trusted)).toBe(true)
    // 双栈 socket 上 Node 给的是这个形状，漏了它白名单就等于没配
    expect(isTrustedClientAddress('::ffff:172.22.240.5', trusted)).toBe(true)
    expect(isTrustedClientAddress('10.0.0.9', trusted)).toBe(true)
    expect(isTrustedClientAddress('172.22.240.6', trusted)).toBe(false)
    // 通配只吃最后一段，不会把 10.0.1.9 也算进来
    expect(isTrustedClientAddress('10.0.1.9', trusted)).toBe(false)
  })

  it('trusts nobody by default', () => {
    expect(isTrustedClientAddress('172.22.240.5', new Set())).toBe(false)
    expect(isTrustedClientAddress('172.22.240.5', undefined)).toBe(false)
    expect(isTrustedClientAddress('', new Set(['172.22.240.5']))).toBe(false)
  })
})

describe('remoteRequestAllowed', () => {
  it('lets a remote client reach the share view and nothing else that is a page', () => {
    // 分享链接本身：页面 + 它下面的资源
    expect(remoteRequestAllowed('/share')).toBe(true)
    expect(remoteRequestAllowed('/share/')).toBe(true)
    expect(remoteRequestAllowed('/share/assets/index-abc.js')).toBe(true)
    // 主页面、显式基路径、独立窗口、控制端点都不给
    expect(remoteRequestAllowed('/')).toBe(false)
    expect(remoteRequestAllowed('/mica-web')).toBe(false)
    expect(remoteRequestAllowed('/mica-web/')).toBe(false)
    expect(remoteRequestAllowed('/files')).toBe(false)
    expect(remoteRequestAllowed('/terminal-control')).toBe(false)
    expect(remoteRequestAllowed('/terminal.html')).toBe(false)
    expect(remoteRequestAllowed('/files.html')).toBe(false)
    expect(remoteRequestAllowed('/index.html')).toBe(false)
    expect(remoteRequestAllowed('/remote/control')).toBe(false)
    expect(remoteRequestAllowed('/remote/terminal/sessions')).toBe(false)
    expect(remoteRequestAllowed('/mcp/terminal')).toBe(false)
  })

  it('lets the share page load its own assets from the origin root', () => {
    // 打开 `/share?session=x` 时相对引用按 `/` 解析，资源落在根路径下
    expect(remoteRequestAllowed('/assets/index-abc.js')).toBe(true)
    expect(remoteRequestAllowed('/assets/index-abc.css')).toBe(true)
    expect(remoteRequestAllowed('/favicon.ico')).toBe(true)
    expect(remoteRequestAllowed('/manifest.webmanifest')).toBe(true)
  })

  it('keeps the api the share page talks to, but not the bare /api path', () => {
    // 分享视图与主应用共用同一份接口：收窄它等于把分享链接废掉
    expect(remoteRequestAllowed('/api/invoke')).toBe(true)
    expect(remoteRequestAllowed('/api/events')).toBe(true)
    expect(remoteRequestAllowed('/api/health')).toBe(true)
    // `/api` 没有处理器，会落到「SPA 回退成 index.html」上——那是主页面
    expect(remoteRequestAllowed('/api')).toBe(false)
  })

  it('cannot be smuggled out of the share prefix', () => {
    expect(remoteRequestAllowed('/share/../terminal.html')).toBe(false)
    expect(remoteRequestAllowed('/share/%2e%2e/terminal.html')).toBe(false)
    expect(remoteRequestAllowed('//evil.example/share')).toBe(false)
  })
})

describe('pickShareBaseUrl', () => {
  const lan = [{ address: '192.168.1.23', internal: false }]

  it('prefers the pinned public url and keeps its scheme', () => {
    // 分享视图住在 /share 下：公网地址只写到域名时要把路径补上，否则分享出去的
    // 链接落在完整应用上（带左侧会话列表）
    expect(
      pickShareBaseUrl({ publicUrl: 'https://mica.example.com/', port: 8788, addresses: lan })
    ).toBe('https://mica.example.com/share')
    // 自带路径的部署（反向代理挂在子路径下）按原样用
    expect(
      pickShareBaseUrl({ publicUrl: 'https://mica.example.com/mica', port: 8788, addresses: lan })
    ).toBe('https://mica.example.com/mica')
    // 认不出来的 public url 退回网卡地址，而不是给出一条坏链接
    expect(pickShareBaseUrl({ publicUrl: 'not a url', port: 8788, addresses: lan })).toBe(
      'http://192.168.1.23:8788/share'
    )
  })

  it('prefers the address the sharer is already using, when it is one of ours', () => {
    const allowed = new Set(['192.168.1.23'])
    expect(
      pickShareBaseUrl({
        port: 8788,
        addresses: [{ address: '172.17.0.1' }],
        // 分享者自己是从某个局域网地址打开页面的：那一张网最可靠，端口换成运行时自己的
        preferredOrigin: 'http://192.168.1.23:8787',
        allowedHostnames: allowed
      })
    ).toBe('http://192.168.1.23:8788/share')
    // docker0 那种别的机器连不到的网卡不会被优先选中
    expect(
      pickShareBaseUrl({
        port: 8788,
        addresses: lan,
        preferredOrigin: 'http://172.17.0.1:8787',
        allowedHostnames: allowed
      })
    ).toBe('http://192.168.1.23:8788/share')
    // 不在白名单里的地址（对方发来的链接之类）也不认
    expect(
      pickShareBaseUrl({
        port: 8788,
        addresses: lan,
        preferredOrigin: 'http://10.0.0.9:8787',
        allowedHostnames: allowed
      })
    ).toBe('http://192.168.1.23:8788/share')
  })

  it('ranks private lan over public ipv4 over ipv6, and drops link-local', () => {
    expect(
      pickShareBaseUrl({
        port: 8788,
        addresses: [{ address: '8.8.8.8' }, { address: 'fe80::1' }, { address: '192.168.1.23' }]
      })
    ).toBe('http://192.168.1.23:8788/share')
    expect(pickShareBaseUrl({ port: 8788, addresses: [{ address: '8.8.8.8' }] })).toBe(
      'http://8.8.8.8:8788/share'
    )
    // IPv6 要带方括号，否则拼出来的地址解析不了
    expect(pickShareBaseUrl({ port: 8788, addresses: [{ address: 'fd00::2' }] })).toBe(
      'http://[fd00::2]:8788/share'
    )
  })

  it('returns null when only loopback is available, or sharing is off', () => {
    expect(pickShareBaseUrl({ port: 8788, addresses: [{ address: '127.0.0.1' }] })).toBeNull()
    expect(
      pickShareBaseUrl({
        port: 8788,
        addresses: [{ address: '192.168.1.23', internal: true }]
      })
    ).toBeNull()
    expect(pickShareBaseUrl({ addresses: lan })).toBeNull()
    expect(pickShareBaseUrl()).toBeNull()
    // 没有端口时不给分享地址（分享关掉时 access.js 直接返回 null，不会调到这里）
    expect(pickShareBaseUrl({ port: 0, addresses: lan })).toBeNull()
  })
})
