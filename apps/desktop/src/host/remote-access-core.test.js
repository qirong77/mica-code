import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_REMOTE_ACCESS_PASSWORD,
  SHARE_SCOPE_COOKIE,
  REMOTE_ACCESS_COOKIE,
  createLoginThrottle,
  emptyRemoteAccessPolicy,
  hasScopeToken,
  normalizeRemoteAccessPassword,
  normalizeRemoteAccessPolicy,
  parseCookies,
  remoteAccessCookie,
  remoteAccessDecision,
  remoteAccessToken,
  safeNextPath,
  verifyRemoteAccessPassword,
  withGeneratedSecret
} from './remote-access-core'

const withSecret = (patch = {}) => withGeneratedSecret({ ...emptyRemoteAccessPolicy(), ...patch })

describe('normalizeRemoteAccessPolicy', () => {
  it('defaults to "off, password 0000" and ignores unknown shapes', () => {
    // 默认不暴露完整接口：加了这条通道不等于默认打开
    expect(normalizeRemoteAccessPolicy(undefined).enabled).toBe(false)
    expect(normalizeRemoteAccessPolicy(null).password).toBe(DEFAULT_REMOTE_ACCESS_PASSWORD)
    expect(normalizeRemoteAccessPolicy('nonsense').password).toBe(DEFAULT_REMOTE_ACCESS_PASSWORD)
    expect(normalizeRemoteAccessPolicy({ enabled: 'yes' }).enabled).toBe(false)
  })

  it('keeps a usable password and drops a broken one', () => {
    expect(normalizeRemoteAccessPolicy({ enabled: true, password: ' 1234 ' }).password).toBe('1234')
    // 空串 / 纯空白不能变成「打开但没有口令」
    expect(normalizeRemoteAccessPolicy({ password: '   ' }).password).toBe(
      DEFAULT_REMOTE_ACCESS_PASSWORD
    )
    expect(normalizeRemoteAccessPolicy({ password: 'a'.repeat(65) }).password).toBe(
      DEFAULT_REMOTE_ACCESS_PASSWORD
    )
    expect(normalizeRemoteAccessPassword('a\nb')).toBeNull()
  })

  it('only accepts a secret that looks like one', () => {
    expect(normalizeRemoteAccessPolicy({ secret: 'not hex' }).secret).toBe('')
    expect(normalizeRemoteAccessPolicy({ secret: 'ab'.repeat(24) }).secret).toBe('ab'.repeat(24))
    expect(withSecret().secret.length).toBeGreaterThanOrEqual(32)
  })
})

describe('remoteAccessToken', () => {
  it('is scoped, and changes when the password changes', () => {
    const policy = withSecret({ password: '0000' })
    const access = remoteAccessToken(policy, 'access')
    const share = remoteAccessToken(policy, 'share')
    expect(access).toMatch(/^[0-9a-f]{64}$/)
    // 打开过分享页的凭据不该能当过门凭据
    expect(access).not.toBe(share)
    expect(remoteAccessToken({ ...policy, password: '1234' }, 'access')).not.toBe(access)
    // 换 secret（重新生成策略）同样让旧令牌失效
    expect(remoteAccessToken(withSecret({ password: '0000' }), 'access')).not.toBe(access)
  })

  it('produces nothing without a secret, so nothing can match', () => {
    const policy = emptyRemoteAccessPolicy()
    expect(remoteAccessToken(policy, 'access')).toBe('')
    const cookies = parseCookies(`${REMOTE_ACCESS_COOKIE}=`)
    expect(hasScopeToken(cookies, policy, 'access')).toBe(false)
  })
})

describe('verifyRemoteAccessPassword', () => {
  const policy = withSecret({ enabled: true, password: '0000' })

  it('accepts the configured password and trims the input', () => {
    expect(verifyRemoteAccessPassword('0000', policy)).toBe(true)
    expect(verifyRemoteAccessPassword(' 0000 ', policy)).toBe(true)
  })

  it('rejects wrong, empty and malformed input', () => {
    expect(verifyRemoteAccessPassword('0001', policy)).toBe(false)
    expect(verifyRemoteAccessPassword('', policy)).toBe(false)
    expect(verifyRemoteAccessPassword('   ', policy)).toBe(false)
    expect(verifyRemoteAccessPassword(null, policy)).toBe(false)
    expect(verifyRemoteAccessPassword('00000', policy)).toBe(false)
  })
})

describe('parseCookies', () => {
  it('parses names, quoted values and skips malformed segments', () => {
    const cookies = parseCookies('a=1; b="two"; broken; c=')
    expect(cookies.get('a')).toBe('1')
    expect(cookies.get('b')).toBe('two')
    expect(cookies.get('c')).toBe('')
    expect(cookies.has('broken')).toBe(false)
    expect(parseCookies('').size).toBe(0)
    expect(parseCookies(undefined).size).toBe(0)
  })
})

describe('remoteAccessCookie', () => {
  it('is HttpOnly, path-scoped, and only sets Max-Age when asked', () => {
    const session = remoteAccessCookie(SHARE_SCOPE_COOKIE, 'token')
    expect(session).toContain('HttpOnly')
    expect(session).toContain('SameSite=Lax')
    expect(session).toContain('Path=/')
    expect(session).not.toContain('Max-Age')
    // 局域网是明文 http：带 Secure 浏览器直接不存
    expect(session).not.toContain('Secure')
    expect(remoteAccessCookie(REMOTE_ACCESS_COOKIE, 'token', { maxAge: 60 })).toContain(
      'Max-Age=60'
    )
  })
})

describe('safeNextPath', () => {
  it('keeps same-site paths and refuses everything that could leave the site', () => {
    expect(safeNextPath('/mica-web')).toBe('/mica-web')
    expect(safeNextPath('/share?session=abc')).toBe('/share?session=abc')
    expect(safeNextPath('//evil.example/x')).toBe('/')
    expect(safeNextPath('https://evil.example')).toBe('/')
    expect(safeNextPath('/a/../b')).toBe('/')
    expect(safeNextPath('')).toBe('/')
    expect(safeNextPath(undefined)).toBe('/')
  })
})

describe('remoteAccessDecision', () => {
  const off = emptyRemoteAccessPolicy()
  const on = { ...off, enabled: true }

  it('always lets a local client or a valid access token through', () => {
    for (const pathname of [
      '/',
      '/mica-web',
      '/files',
      '/api/invoke',
      '/mcp/terminal',
      '/x.html'
    ]) {
      expect(remoteAccessDecision({ local: true, policy: off, pathname })).toBe('allow')
      expect(remoteAccessDecision({ local: true, policy: on, pathname })).toBe('allow')
      expect(remoteAccessDecision({ policy: on, pathname, hasAccess: true })).toBe('allow')
    }
  })

  it('shows a share link that points at a real session, password or not', () => {
    for (const policy of [off, on]) {
      expect(remoteAccessDecision({ policy, pathname: '/share', shareLink: true })).toBe('allow')
      // 资源本身不含数据：登录页和分享页都要靠它才画得出来
      expect(remoteAccessDecision({ policy, pathname: '/assets/index-abc.js' })).toBe('allow')
    }
  })

  it('does not treat a bare /share or an invented id as a link', () => {
    // 分享列表页会列出所有分享过的会话：它不是「别人手上那条链接」
    expect(remoteAccessDecision({ policy: off, pathname: '/share' })).toBe('not-found')
    expect(remoteAccessDecision({ policy: on, pathname: '/share' })).toBe('login')
    expect(remoteAccessDecision({ policy: off, pathname: '/share?session=nope' })).toBe('not-found')
    expect(remoteAccessDecision({ policy: on, pathname: '/share?session=nope' })).toBe('login')
    // 打开过链接的浏览器可以回到链接本身
    expect(
      remoteAccessDecision({ policy: on, pathname: '/share', hasShare: true, shareLink: true })
    ).toBe('allow')
  })

  it('hides everything else when no password is configured', () => {
    expect(remoteAccessDecision({ policy: off, pathname: '/' })).toBe('not-found')
    expect(remoteAccessDecision({ policy: off, pathname: '/mica-web' })).toBe('not-found')
    expect(remoteAccessDecision({ policy: off, pathname: '/files' })).toBe('not-found')
    // 接口等于整台机器（shell、文件、配置里的 key）：没口令、也没有分享链接就不给
    expect(remoteAccessDecision({ policy: off, pathname: '/api/invoke' })).toBe('not-found')
    expect(remoteAccessDecision({ policy: off, pathname: '/api/events' })).toBe('not-found')
  })

  it('opens the api only for a browser that already opened a valid link', () => {
    // 分享页自己要调接口：凭据来自打开链接时签发的那张 cookie
    expect(remoteAccessDecision({ policy: off, pathname: '/api/invoke', hasShare: true })).toBe(
      'allow'
    )
    expect(remoteAccessDecision({ policy: on, pathname: '/api/invoke', hasShare: true })).toBe(
      'allow'
    )
    // 但那张 cookie 开不了完整界面
    expect(remoteAccessDecision({ policy: on, pathname: '/', hasShare: true })).toBe('login')
    expect(remoteAccessDecision({ policy: off, pathname: '/', hasShare: true })).toBe('not-found')
    expect(remoteAccessDecision({ policy: off, pathname: '/files', hasShare: true })).toBe(
      'not-found'
    )
  })

  // 侧栏 Connections 连另一台机器时，是先探活再开窗的：探活若被口令挡住，
  // 那个功能就永远只能报「连接失败」，无论对方配置得多正确。
  it('lets any remote client read the health fingerprint', () => {
    for (const policy of [off, on]) {
      expect(remoteAccessDecision({ policy, pathname: '/api/health' })).toBe('allow')
    }
    // 指纹之外照旧要口令：能探活 ≠ 能用接口
    expect(remoteAccessDecision({ policy: on, pathname: '/api/invoke' })).toBe('login')
    expect(remoteAccessDecision({ policy: off, pathname: '/api/invoke' })).toBe('not-found')
  })

  it('asks for the password once it is enabled', () => {
    expect(remoteAccessDecision({ policy: on, pathname: '/' })).toBe('login')
    expect(remoteAccessDecision({ policy: on, pathname: '/mica-web' })).toBe('login')
    expect(remoteAccessDecision({ policy: on, pathname: '/terminal.html' })).toBe('login')
    // 裸接口调用要凭据：口令进来的算，打开过分享链接的也算
    expect(remoteAccessDecision({ policy: on, pathname: '/api/invoke' })).toBe('login')
    expect(remoteAccessDecision({ policy: on, pathname: '/api/invoke', hasShare: true })).toBe(
      'allow'
    )
  })

  it('treats a missing path as hidden rather than as the app', () => {
    expect(remoteAccessDecision({ policy: off, pathname: '' })).toBe('not-found')
    expect(remoteAccessDecision({ policy: on, pathname: undefined })).toBe('login')
  })

  describe('createLoginThrottle', () => {
    it('locks one peer after the failure budget and clears on success', () => {
      let clock = 1_000
      const throttle = createLoginThrottle({ maxFailures: 3, lockMs: 500, now: () => clock })
      expect(throttle.retryAfterMs('a')).toBe(0)
      throttle.recordFailure('a')
      throttle.recordFailure('a')
      expect(throttle.retryAfterMs('a')).toBe(0)
      throttle.recordFailure('a')
      expect(throttle.retryAfterMs('a')).toBe(500)
      // 另一个来源不受牵连
      expect(throttle.retryAfterMs('b')).toBe(0)
      clock += 500
      expect(throttle.retryAfterMs('a')).toBe(0)
      throttle.recordFailure('a')
      throttle.recordSuccess('a')
      expect(throttle.retryAfterMs('a')).toBe(0)
    })
  })
})
