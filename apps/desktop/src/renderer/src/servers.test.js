import { describe, expect, test } from 'bun:test'
import {
  LOCAL_SERVER_URL,
  MAX_RECENT_SERVERS,
  currentServerUrl,
  isElectronShell,
  isLoopbackServer,
  isSameServer,
  openServerTarget,
  parseRecentServers,
  readRecentServers,
  rememberServer,
  serverListRows,
  serverLabel
} from './servers'

function fakeStorage(initial) {
  const data = new Map(initial ? Object.entries(initial) : [])
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    raw: () => Object.fromEntries(data)
  }
}

describe('currentServerUrl', () => {
  test('uses the page origin, which is the runtime hosting it', () => {
    expect(currentServerUrl({ origin: 'http://192.168.1.5:8787' })).toBe('http://192.168.1.5:8787')
    expect(currentServerUrl(undefined)).toBe('')
  })
})

describe('isLoopbackServer', () => {
  test('recognizes the machine the page runs on', () => {
    for (const url of [LOCAL_SERVER_URL, 'http://localhost:8787', 'http://[::1]:9000']) {
      expect(isLoopbackServer(url)).toBe(true)
    }
    for (const url of ['http://192.168.1.5:8787', 'http://box:8787', 'nonsense']) {
      expect(isLoopbackServer(url)).toBe(false)
    }
  })
})

describe('serverLabel', () => {
  test('calls loopback "本机" and keeps host:port for the rest', () => {
    expect(serverLabel(LOCAL_SERVER_URL)).toBe('本机')
    expect(serverLabel('http://192.168.1.5:8787')).toBe('192.168.1.5:8787')
    expect(serverLabel('http://box:9000')).toBe('box:9000')
  })
})

describe('isSameServer', () => {
  test('compares hosts and ignores the path', () => {
    expect(isSameServer('http://box:8787', 'http://box:8787/api/health')).toBe(true)
    expect(isSameServer('http://box:8787', 'http://box:9000')).toBe(false)
    expect(isSameServer('http://box:8787', 'not a url')).toBe(false)
  })
})

describe('isElectronShell', () => {
  test('recognizes the container by its user agent', () => {
    expect(
      isElectronShell(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Electron/39.2.6 Safari/537.36'
      )
    ).toBe(true)
    expect(isElectronShell('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1')).toBe(false)
    expect(isElectronShell(undefined)).toBe(false)
  })
})

describe('openServerTarget', () => {
  const target = 'http://192.168.1.5:8787'
  const electronUa = 'Mozilla/5.0 Electron/39.2.6 Safari/537.36'

  test('hands the navigation to the shell, which opens a new window', () => {
    const assigned = []
    const result = openServerTarget(target, {
      userAgent: electronUa,
      assign: (url) => assigned.push(url),
      open: () => {
        throw new Error('外壳里不该自己开标签页')
      }
    })

    expect(result).toBe('window')
    expect(assigned).toEqual([target])
  })

  test('opens a new tab in a browser and severs the opener', () => {
    const assigned = []
    const spawned = { opener: {} }
    const result = openServerTarget(target, {
      userAgent: 'Mozilla/5.0 Safari/604.1',
      open: () => spawned,
      assign: (url) => assigned.push(url)
    })

    expect(result).toBe('tab')
    expect(spawned.opener).toBeNull()
    expect(assigned).toEqual([])
  })

  test('falls back to this tab when the popup is blocked', () => {
    const assigned = []
    const result = openServerTarget(target, {
      userAgent: 'Mozilla/5.0 Safari/604.1',
      open: () => null,
      assign: (url) => assigned.push(url)
    })

    expect(result).toBe('same-tab')
    expect(assigned).toEqual([target])
  })
})

describe('remembered servers', () => {
  test('drops junk, deduplicates by host and caps the list', () => {
    expect(parseRecentServers(null)).toEqual([])
    expect(parseRecentServers(['http://a:8787', 'nonsense', 'http://a:8787/api', 42])).toEqual([
      'http://a:8787'
    ])

    const many = Array.from(
      { length: MAX_RECENT_SERVERS + 4 },
      (_, index) => `http://h${index}:8787`
    )
    expect(parseRecentServers(many)).toHaveLength(MAX_RECENT_SERVERS)
  })

  test('reads an empty or corrupt store as an empty list', () => {
    expect(readRecentServers(fakeStorage())).toEqual([])
    expect(readRecentServers(fakeStorage({ 'mica-servers': '{ not json' }))).toEqual([])
    expect(readRecentServers(null)).toEqual([])
  })

  test('remembers the newest first and never repeats a host', () => {
    const storage = fakeStorage()
    expect(rememberServer('http://a:8787', storage)).toEqual(['http://a:8787'])
    expect(rememberServer('http://b:8787', storage)).toEqual(['http://b:8787', 'http://a:8787'])
    // 同一个 host 换个写法（路径/大小写）不该变成两条
    expect(rememberServer('http://A:8787/api/health', storage)).toEqual([
      'http://a:8787',
      'http://b:8787'
    ])
    expect(readRecentServers(storage)).toEqual(['http://a:8787', 'http://b:8787'])
  })

  test('ignores an address that is not a runtime origin', () => {
    const storage = fakeStorage()
    rememberServer('http://a:8787', storage)
    expect(rememberServer('192.168.1.5:8787', storage)).toEqual(['http://a:8787'])
    expect(rememberServer('', storage)).toEqual(['http://a:8787'])
  })

  test('survives a store that cannot be written', () => {
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      }
    }
    expect(rememberServer('http://a:8787', storage)).toEqual(['http://a:8787'])
  })
})

describe('serverListRows', () => {
  const local = LOCAL_SERVER_URL

  test('hides the current server and the 本机 shortcut', () => {
    const recent = ['http://a:8787', local, 'http://b:8787']

    // 正在本机上：本机不再作为快捷方式出现，也不该在清单里重复
    expect(serverListRows(local, recent)).toEqual(['http://a:8787', 'http://b:8787'])
    // 在 a 上：a 是当前那台（单独一行），本机作为回程入口单独显示
    expect(serverListRows('http://a:8787', recent)).toEqual(['http://b:8787'])
  })

  test('returns nothing while there is no history', () => {
    expect(serverListRows(local, [])).toEqual([])
  })
})
