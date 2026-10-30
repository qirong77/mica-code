import { describe, expect, it } from 'bun:test'

/**
 * 主题运行时是模块级单例（一个页面只有一个当前主题），所以测试先把浏览器全局搭好，
 * 再加载模块。`window.matchMedia` 返回一个可变的 MediaQueryList，测试改 `matches` 后
 * 手动触发注册的 change 回调，等价于系统亮暗切换。
 */
const storage = new Map()
const meta = { content: '' }
const html = { attributes: {}, style: {} }
const media = { matches: false, handler: null }

globalThis.window = {
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value))
  },
  matchMedia: () => ({
    get matches() {
      return media.matches
    },
    addEventListener: (_event, handler) => {
      media.handler = handler
    }
  }),
  mica: undefined
}

globalThis.document = {
  documentElement: {
    setAttribute: (name, value) => {
      html.attributes[name] = value
    },
    style: html.style
  },
  querySelector: (selector) =>
    selector === 'meta[name="theme-color"]'
      ? {
          setAttribute: (name, value) => {
            if (name === 'content') meta.content = value
          }
        }
      : null
}

const theme = await import('./theme.js')

/** 模拟系统主题变化：改 matches 再触发模块注册的回调。 */
function setSystemPrefersLight(prefersLight) {
  media.matches = prefersLight
  media.handler?.()
}

describe('theme runtime', () => {
  it('boots from the cached preference and applies it to the document', () => {
    media.matches = false
    storage.set(theme.THEME_CACHE_KEY, 'light')

    theme.initThemeFromCache()

    expect(html.attributes['data-theme']).toBe('light')
    expect(html.style.colorScheme).toBe('light')
    expect(meta.content).toBe('#ffffff')
    expect(theme.currentThemePreference()).toBe('light')
    expect(theme.currentThemeName()).toBe('light')
  })

  it('follows the system only while the preference is auto', () => {
    media.matches = false
    theme.applyThemePreference('auto')
    expect(theme.currentThemePreference()).toBe('auto')
    expect(theme.currentThemeName()).toBe('dark')

    const seen = []
    const unsubscribe = theme.subscribeTheme((resolved) => seen.push(resolved))
    setSystemPrefersLight(true)
    expect(theme.currentThemeName()).toBe('light')
    expect(seen).toEqual(['light'])

    theme.applyThemePreference('dark')
    setSystemPrefersLight(false)
    setSystemPrefersLight(true)
    expect(theme.currentThemeName()).toBe('dark')
    unsubscribe()
    expect(seen).toEqual(['light', 'dark'])
  })

  it('notifies resolved-theme listeners only when the concrete theme changes', () => {
    media.matches = false
    theme.applyThemePreference('auto')
    const seen = []
    const unsubscribe = theme.subscribeTheme((resolved) => seen.push(resolved))
    theme.applyThemePreference('dark')
    theme.applyThemePreference('dark')
    theme.applyThemePreference('light')
    unsubscribe()
    expect(seen).toEqual(['light'])
  })

  it('notifies preference listeners when the preference (not the system) changes', () => {
    const seen = []
    const unsubscribe = theme.subscribeThemePreference((preference) => seen.push(preference))
    theme.applyThemePreference('auto')
    theme.applyThemePreference('dark')
    theme.applyThemePreference('dark')
    unsubscribe()
    expect(seen).toEqual(['auto', 'dark'])
  })

  it('treats unknown stored/remote values as the system-following default', () => {
    media.matches = true
    storage.set(theme.THEME_CACHE_KEY, 'bogus')
    theme.initThemeFromCache()
    expect(theme.currentThemePreference()).toBe('auto')
    expect(theme.currentThemeName()).toBe('light')

    theme.applyThemePreference('dark')
    theme.syncThemeFromUiState('system')
    expect(theme.currentThemePreference()).toBe('auto')
    expect(theme.currentThemeName()).toBe('light')
  })

  it('writes the preference through to runtime ui-state and keeps the local switch', async () => {
    const patches = []
    globalThis.window.mica = {
      uiState: {
        patch: (patch) => {
          patches.push(patch)
          return Promise.resolve()
        }
      }
    }

    theme.setThemePreference('light')
    await Promise.resolve()
    expect(patches).toEqual([{ theme: 'light' }])
    expect(storage.get(theme.THEME_CACHE_KEY)).toBe('light')
    expect(html.attributes['data-theme']).toBe('light')

    globalThis.window.mica = undefined
    expect(() => theme.setThemePreference('dark')).not.toThrow()
    expect(theme.currentThemeName()).toBe('dark')
  })

  it('recomputes the cached theme for windows without a ui-state channel', () => {
    media.matches = false
    storage.set(theme.THEME_CACHE_KEY, 'dark')
    theme.syncThemeFromCache()
    expect(theme.currentThemeName()).toBe('dark')
  })
})
