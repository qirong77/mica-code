import { describe, expect, it } from 'bun:test'
import {
  ACCESS_COOKIE,
  SHARE_TTL_MS,
  activeShareLinks,
  buildSetCookie,
  createShareRecord,
  emptyAccessState,
  filterSessionsForShare,
  grantFromState,
  hostAllowed,
  hostnameOf,
  isLoopbackAddress,
  isPrivateLanAddress,
  normalizeImagePath,
  parseAccessState,
  parseCookieHeader,
  pickShareBaseUrl,
  revokeShareRecord,
  sameSiteOriginAllowed,
  scanImagePaths,
  scopeAllowsChannel,
  scopeAllowsSessionEvent,
  sessionFilePath,
  shareAllowsChannel,
  tokenMatches
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

describe('cookies', () => {
  it('parses a cookie header into a map', () => {
    expect(parseCookieHeader(`${ACCESS_COOKIE}=abc%3D; other=1`)).toEqual({
      [ACCESS_COOKIE]: 'abc=',
      other: '1'
    })
    expect(parseCookieHeader('')).toEqual({})
    expect(parseCookieHeader(undefined)).toEqual({})
  })

  it('builds an HttpOnly, SameSite=Lax cookie', () => {
    const cookie = buildSetCookie(ACCESS_COOKIE, 'tok', { maxAgeSeconds: 3600 })
    expect(cookie).toContain(`${ACCESS_COOKIE}=tok`)
    expect(cookie).toContain('HttpOnly')
    // 必须是 Lax 而不是 Strict：从外部点开链接是跨站顶层导航，Strict 会把 cookie 丢掉
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Max-Age=3600')
    expect(buildSetCookie(ACCESS_COOKIE, 'tok')).toContain('Max-Age=0')
  })
})

describe('tokens', () => {
  it('matches only the exact token, and never an empty or missing one', () => {
    const { record } = createShareRecord({ sessionId: 's1' })
    expect(tokenMatches('anything', record.hash)).toBe(false)
    expect(tokenMatches('', record.hash)).toBe(false)
    expect(tokenMatches(undefined, record.hash)).toBe(false)
    expect(tokenMatches('x', 'not-a-hash')).toBe(false)
  })

  it('issues a distinct token per share record', () => {
    const a = createShareRecord({ sessionId: 's1' })
    const b = createShareRecord({ sessionId: 's1' })
    expect(a.token).not.toBe(b.token)
    expect(a.record.id).not.toBe(b.record.id)
  })

  it('requires a session id', () => {
    expect(() => createShareRecord({})).toThrow()
    expect(() => createShareRecord({ sessionId: '' })).toThrow()
  })
})

describe('grantFromState', () => {
  const state = emptyAccessState('access-token')

  it('gives full scope for the access token', () => {
    expect(grantFromState(state, 'access-token')).toEqual({ kind: 'full', via: 'token' })
  })

  it('gives a session-scoped share for a share token', () => {
    const { token, record } = createShareRecord({ sessionId: 's1', now: 1000 })
    const withLink = { ...state, shareLinks: [record] }
    expect(grantFromState(withLink, token, 2000)).toEqual({
      kind: 'share',
      sessionId: 's1',
      via: 'share'
    })
  })

  it('rejects unknown, empty, expired and revoked tokens', () => {
    const { token, record } = createShareRecord({ sessionId: 's1', ttlMs: 100, now: 1000 })
    const withLink = { ...state, shareLinks: [record] }
    expect(grantFromState(withLink, 'guessed', 1500)).toBeNull()
    expect(grantFromState(withLink, '', 1500)).toBeNull()
    expect(grantFromState(withLink, undefined, 1500)).toBeNull()
    // 过了有效期
    expect(grantFromState(withLink, token, 1200)).toBeNull()
    // 撤销后立刻失效
    const links = [{ ...record }]
    revokeShareRecord(links, record.id, 1100)
    expect(grantFromState({ ...state, shareLinks: links }, token, 1150)).toBeNull()
  })

  it('does not confuse a share token with the access token', () => {
    const { token, record } = createShareRecord({ sessionId: 's1' })
    const withLink = { ...state, shareLinks: [record] }
    // 分享令牌只给 share，绝不能升级成 full
    expect(grantFromState(withLink, token).kind).toBe('share')
    expect(grantFromState({ ...state, shareLinks: [] }, token)).toBeNull()
  })
})

describe('share link lifecycle', () => {
  it('drops expired and revoked links from the active list', () => {
    const live = createShareRecord({ sessionId: 's1', ttlMs: 1000, now: 0 }).record
    const stale = createShareRecord({ sessionId: 's2', ttlMs: 10, now: 0 }).record
    const revoked = createShareRecord({ sessionId: 's3', now: 0 }).record
    revoked.revokedAt = 5
    const active = activeShareLinks([live, stale, revoked], 100)
    expect(active.map((link) => link.sessionId)).toEqual(['s1'])
  })

  it('revokes once and reports whether it hit anything', () => {
    const { record } = createShareRecord({ sessionId: 's1' })
    const links = [record]
    expect(revokeShareRecord(links, record.id, 10)).toBe(true)
    expect(revokeShareRecord(links, record.id, 20)).toBe(false)
    expect(revokeShareRecord(links, 'nope', 20)).toBe(false)
  })

  it('defaults to a 7 day lifetime', () => {
    const { record } = createShareRecord({ sessionId: 's1', now: 1000 })
    expect(record.expiresAt).toBe(1000 + SHARE_TTL_MS)
  })
})

describe('parseAccessState', () => {
  it('round-trips a state and keeps the stored shape', () => {
    const state = emptyAccessState('tok')
    state.shareLinks = [createShareRecord({ sessionId: 's1' }).record]
    const parsed = parseAccessState(JSON.parse(JSON.stringify(state)))
    expect(parsed.accessToken).toBe('tok')
    expect(parsed.shareLinks).toHaveLength(1)
    expect(parsed.shareLinks[0].sessionId).toBe('s1')
  })

  it('rejects unusable files instead of guessing', () => {
    expect(parseAccessState(null)).toBeNull()
    expect(parseAccessState('nope')).toBeNull()
    expect(parseAccessState({ version: 99, accessToken: 'x' })).toBeNull()
    expect(parseAccessState({ version: 1 })).toBeNull()
    expect(parseAccessState({ version: 1, accessToken: '' })).toBeNull()
  })

  it('drops malformed share entries rather than trusting them', () => {
    const parsed = parseAccessState({
      version: 1,
      accessToken: 'tok',
      shareLinks: [{ id: 'a' }, null, 'x', { id: 'b', hash: 'h', sessionId: 's2' }]
    })
    expect(parsed.shareLinks.map((link) => link.id)).toEqual(['b'])
  })
})

describe('scopeAllowsChannel', () => {
  it('lets a full scope through and blocks a missing one', () => {
    expect(scopeAllowsChannel({ kind: 'full' }, 'terminal:write', { data: 'rm -rf /' })).toBe(true)
    expect(scopeAllowsChannel(null, 'chat:history', { sessionId: 's1' })).toBe(false)
  })

  it('lets a share scope drive its own session, like the owner would', () => {
    const scope = { kind: 'share', sessionId: 's1' }
    for (const channel of [
      'chat:history',
      'chat:meta',
      'chat:is-running',
      'chat:start',
      'chat:edit-message',
      'chat:compact',
      'chat:update-cwd',
      'stats:session-detail',
      'stats:session-title',
      'stats:rename-session'
    ]) {
      expect(scopeAllowsChannel(scope, channel, { sessionId: 's1' })).toBe(true)
    }
    // 目录类不带会话：模型/角色列表、会话清单（返回被裁成一行）
    expect(scopeAllowsChannel(scope, 'chat:models', {})).toBe(true)
    expect(scopeAllowsChannel(scope, 'chat:roles', {})).toBe(true)
    expect(scopeAllowsChannel(scope, 'stats:list-sessions', {})).toBe(true)
  })

  it('keeps host-wide capabilities out of a share scope', () => {
    // 宿主能力属于「这台机器」而不是「这个会话」：文件、终端、git、配置里的凭据、
    // 别的会话的归属与删除、全局界面状态、以及再签发令牌（否则能换别的会话的令牌）。
    for (const channel of [
      'terminal:create',
      'terminal:write',
      'terminal:list',
      'files:read',
      'files:write',
      'files:list',
      'files:mention',
      'config-web:invoke',
      'git:checkout',
      'git:status',
      'stats:delete-session',
      'stats:list-pins',
      'stats:move-session',
      'stats:list-projects',
      'stats:set-sort',
      'ui-state:get',
      'ui-state:patch',
      'loops:start',
      'loops:list',
      'auto-compact:set',
      'chat:fork',
      'chat:input-history:read',
      'chat:input-history:append',
      'access:info',
      'share:create',
      'share:list',
      'share:revoke'
    ]) {
      expect(shareAllowsChannel(channel, { sessionId: 's1' }, 's1')).toBe(false)
    }
  })

  it('resolves node-scoped run operations host-side instead of trusting the client', () => {
    const scope = { kind: 'share', sessionId: 's1' }
    const mine = () => 's1'
    const other = () => 's2'
    for (const channel of [
      'chat:abort',
      'chat:recall-queued',
      'chat:kill-background-task',
      'chat:background-task-output',
      'chat:subagent-detail',
      'chat:kill-subagent',
      'chat:dispose'
    ]) {
      expect(scopeAllowsChannel(scope, channel, { id: 'node-1' }, mine)).toBe(true)
      // 这个 node 跑的是别的会话 → 拒绝，客户端自称什么都不算（payload 里根本没有会话）
      expect(scopeAllowsChannel(scope, channel, { id: 'node-1' }, other)).toBe(false)
      // 解析不出来（本运行时没有这个 node 的 run）→ 拒绝，不退回客户端自称
      expect(scopeAllowsChannel(scope, channel, { id: 'node-1' }, () => null)).toBe(false)
    }
  })

  it('refuses a session channel aimed at a node that belongs to another session', () => {
    const scope = { kind: 'share', sessionId: 's1' }
    // 客户端说「写 s1」，但这个 node 在本运行时已经跑着 s2：不能借它把 prompt 打进 s2
    expect(
      scopeAllowsChannel(scope, 'chat:start', { id: 'node-1', sessionId: 's1' }, () => 's2')
    ).toBe(false)
    // node 未知（刷新后新开的节点）时按客户端自称的会话走
    expect(
      scopeAllowsChannel(scope, 'chat:start', { id: 'node-new', sessionId: 's1' }, () => null)
    ).toBe(true)
    expect(
      scopeAllowsChannel(scope, 'chat:start', { id: 'node-1', sessionId: 's1' }, () => 's1')
    ).toBe(true)
  })

  it('refuses to read another session with an allowed channel', () => {
    const scope = { kind: 'share', sessionId: 's1' }
    // 白名单 channel 也必须限定在这一个会话上，否则分享令牌就能遍历全部历史
    expect(scopeAllowsChannel(scope, 'chat:history', { sessionId: 's2' })).toBe(false)
    expect(scopeAllowsChannel(scope, 'chat:history', {})).toBe(false)
    expect(scopeAllowsChannel(scope, 'chat:history', undefined)).toBe(false)
  })
})

describe('scopeAllowsSessionEvent', () => {
  it('keeps the share stream to its own session', () => {
    const scope = { kind: 'share', sessionId: 's1' }
    expect(scopeAllowsSessionEvent(scope, 's1')).toBe(true)
    expect(scopeAllowsSessionEvent(scope, 's2')).toBe(false)
    expect(scopeAllowsSessionEvent(scope, undefined)).toBe(false)
    expect(scopeAllowsSessionEvent({ kind: 'full' }, 's2')).toBe(true)
    expect(scopeAllowsSessionEvent(null, 's1')).toBe(false)
  })
})

describe('pickShareBaseUrl', () => {
  const addresses = [
    { address: '127.0.0.1', internal: true },
    { address: '192.168.1.23', internal: false },
    { address: '10.8.0.3', internal: false },
    { address: 'fe80::1', internal: false }
  ]

  it('never hands out a loopback address', () => {
    // 没有可用的网卡地址时宁可返回 null（页面就不提供分享），也不能给 127.0.0.1：
    // 对方点开只会连到他自己的机器
    expect(pickShareBaseUrl({ port: 8787, addresses: [] })).toBeNull()
    expect(pickShareBaseUrl({ port: 0, addresses })).toBeNull()
  })

  it('prefers the configured public url', () => {
    expect(
      pickShareBaseUrl({ publicUrl: 'https://mica.example.com/', port: 8787, addresses })
    ).toBe('https://mica.example.com')
  })

  it('prefers the sharer own LAN origin when it is one of ours', () => {
    expect(
      pickShareBaseUrl({
        port: 8787,
        addresses,
        preferredOrigin: 'http://192.168.1.23:8787',
        allowedHostnames: new Set(['192.168.1.23'])
      })
    ).toBe('http://192.168.1.23:8787')
    // 不是本机地址（或就是环回）时不采信
    expect(
      pickShareBaseUrl({ port: 8787, addresses, preferredOrigin: 'http://127.0.0.1:8787' })
    ).toBe('http://192.168.1.23:8787')
    expect(
      pickShareBaseUrl({
        port: 8787,
        addresses,
        preferredOrigin: 'http://evil.example:8787',
        allowedHostnames: new Set(['192.168.1.23'])
      })
    ).toBe('http://192.168.1.23:8787')
  })

  it('picks a private LAN address over other candidates and skips link-local IPv6', () => {
    expect(pickShareBaseUrl({ port: 8787, addresses })).toBe('http://192.168.1.23:8787')
    expect(pickShareBaseUrl({ port: 8787, addresses: [{ address: '203.0.113.9' }] })).toBe(
      'http://203.0.113.9:8787'
    )
    expect(pickShareBaseUrl({ port: 8787, addresses: [{ address: 'fe80::1' }] })).toBeNull()
  })

  it('brackets an IPv6 candidate', () => {
    expect(pickShareBaseUrl({ port: 8787, addresses: [{ address: 'fd00::5' }] })).toBe(
      'http://[fd00::5]:8787'
    )
  })
})

describe('isPrivateLanAddress', () => {
  it('covers the RFC1918 ranges only', () => {
    expect(isPrivateLanAddress('10.0.0.1')).toBe(true)
    expect(isPrivateLanAddress('192.168.1.1')).toBe(true)
    expect(isPrivateLanAddress('172.16.0.1')).toBe(true)
    expect(isPrivateLanAddress('172.31.255.254')).toBe(true)
    expect(isPrivateLanAddress('172.32.0.1')).toBe(false)
    expect(isPrivateLanAddress('172.15.0.1')).toBe(false)
    expect(isPrivateLanAddress('8.8.8.8')).toBe(false)
    expect(isPrivateLanAddress('fd00::1')).toBe(false)
  })
})

describe('normalizeImagePath', () => {
  it('expands ~ against the given home and unifies separators', () => {
    expect(normalizeImagePath('~/.mica/images/a.png', '/Users/me')).toBe(
      '/Users/me/.mica/images/a.png'
    )
    expect(normalizeImagePath('~', '/Users/me')).toBe('/Users/me')
    expect(normalizeImagePath('/abs/a.png', '/Users/me')).toBe('/abs/a.png')
    expect(normalizeImagePath('', '/Users/me')).toBe('')
    expect(normalizeImagePath(undefined, '/Users/me')).toBe('')
  })
})

describe('scanImagePaths', () => {
  const home = '/Users/me'

  it('finds the markdown image references the renderer will request', () => {
    const text = JSON.stringify({
      content: [
        { type: 'text', text: '看看这个 [Image](~/.mica/images/a-1.png)' },
        { type: 'text', text: '还有 ![](/tmp/chart.jpg)' }
      ]
    })
    const paths = scanImagePaths(text, home)
    expect(paths.has('/Users/me/.mica/images/a-1.png')).toBe(true)
    expect(paths.has('/tmp/chart.jpg')).toBe(true)
  })

  it('ignores image files that are merely mentioned in prose without a path prefix', () => {
    // 相对路径渲染层根本不会拿去请求 /api/image，收进来只会扩大白名单
    const paths = scanImagePaths('see assets/logo.png and a.png', home)
    expect(paths.size).toBe(0)
  })

  it('finds Windows paths, including the JSON-escaped form', () => {
    // 会话文件里是 JSON，反斜杠成对出现；还原后必须与渲染层发出的路径逐字相同
    const text = JSON.stringify({ text: '[Image](C:\\Users\\me\\images\\a.png)' })
    expect(text).toContain('C:\\\\Users')
    expect([...scanImagePaths(text, home)]).toEqual(['C:/Users/me/images/a.png'])
  })

  it('is not confused by inline base64 payloads', () => {
    const base64 = 'A'.repeat(4000)
    const text = `{"data":"data:image/png;base64,${base64}","path":"/tmp/real.png"}`
    const paths = scanImagePaths(text, home)
    expect([...paths]).toEqual(['/tmp/real.png'])
  })

  it('ignores non-image extensions', () => {
    expect(scanImagePaths('/tmp/notes.txt /tmp/archive.zip', home).size).toBe(0)
  })
})

describe('sessionFilePath', () => {
  it('builds a path under sessions and refuses traversal', () => {
    expect(sessionFilePath('/home/me/.mica', 'abc')).toBe('/home/me/.mica/sessions/abc.json')
    expect(sessionFilePath('/home/me/.mica', '../config')).toBeNull()
    expect(sessionFilePath('/home/me/.mica', 'a/b')).toBeNull()
    expect(sessionFilePath('/home/me/.mica', '')).toBeNull()
    expect(sessionFilePath('/home/me/.mica', undefined)).toBeNull()
  })
})

describe('filterSessionsForShare', () => {
  it('keeps only the shared session so other titles and cwds never leak', () => {
    const result = filterSessionsForShare(
      {
        sessions: [
          { id: 'shared', title: '被分享的会话', cwd: '/w' },
          { id: 'other', title: '别人的会话', cwd: '/secret' }
        ]
      },
      'shared'
    )
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0].title).toBe('被分享的会话')
    expect(JSON.stringify(result)).not.toContain('别人的会话')
  })

  it('drops the row when the shared session is gone', () => {
    expect(filterSessionsForShare({ sessions: [{ id: 'other' }] }, 'shared').sessions).toEqual([])
  })

  it('leaves unexpected payloads untouched instead of guessing', () => {
    expect(filterSessionsForShare(null, 'shared')).toBeNull()
    expect(filterSessionsForShare({ sessions: 'nope' }, 'shared')).toEqual({ sessions: 'nope' })
  })
})

describe('share scope channel whitelist', () => {
  it('allows the shared session reads, including the title list', () => {
    expect(shareAllowsChannel('chat:history', { sessionId: 'a' }, 'a')).toBe(true)
    expect(shareAllowsChannel('stats:list-sessions', {}, 'a')).toBe(true)
    expect(shareAllowsChannel('stats:session-title', { sessionId: 'a' }, 'a')).toBe(true)
  })

  it('refuses host capabilities no matter the payload', () => {
    for (const channel of [
      'terminal:create',
      'files:read',
      'files:write',
      'config-web:invoke',
      'git:status',
      'stats:delete-session',
      'access:info',
      'app:servers:probe'
    ])
      expect(shareAllowsChannel(channel, { sessionId: 'a' }, 'a')).toBe(false)
  })

  it('will not read another session through a whitelisted channel', () => {
    expect(shareAllowsChannel('chat:history', { sessionId: 'b' }, 'a')).toBe(false)
    expect(shareAllowsChannel('chat:history', {}, 'a')).toBe(false)
  })

  it('lets full scope through and denies everything without a scope', () => {
    expect(scopeAllowsChannel({ kind: 'full' }, 'terminal:create', {})).toBe(true)
    expect(scopeAllowsChannel(null, 'chat:history', { sessionId: 'a' })).toBe(false)
  })
})
