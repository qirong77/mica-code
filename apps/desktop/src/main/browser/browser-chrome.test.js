import { describe, expect, it } from 'bun:test'
import { chromePageUrl, recentPageUrl } from './browser-chrome.js'

/**
 * 顶栏页面地址。
 *
 * 页面本身是独立渲染入口（运行时托管 `/browser-chrome`，dev 下是 Vite 的
 * `/browser-chrome.html`）；这里只校验主进程拼出来的地址，页面内部的行为由
 * renderer 的组件测试覆盖。
 */
describe('chromePageUrl', () => {
  it('points at the runtime page in production', () => {
    expect(chromePageUrl('http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787/browser-chrome')
  })

  it('uses the Vite page in dev', () => {
    expect(chromePageUrl('http://localhost:5173', { dev: true })).toBe(
      'http://localhost:5173/browser-chrome.html'
    )
  })

  it('returns empty while the runtime address is unknown', () => {
    expect(chromePageUrl('')).toBe('')
    expect(chromePageUrl(null)).toBe('')
    expect(chromePageUrl('  ')).toBe('')
  })

  it('trims trailing slashes instead of doubling them', () => {
    expect(chromePageUrl('http://127.0.0.1:8787///')).toBe(
      'http://127.0.0.1:8787/browser-chrome'
    )
  })

  it('marks the recent panel with a view query', () => {
    expect(recentPageUrl('http://127.0.0.1:8787')).toBe(
      'http://127.0.0.1:8787/browser-chrome?view=recent'
    )
    expect(recentPageUrl('http://localhost:5173', { dev: true })).toBe(
      'http://localhost:5173/browser-chrome.html?view=recent'
    )
  })
})
