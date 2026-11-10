import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { AccessDeniedError, ensureMicaApi } from './transport.js'

const source = readFileSync(new URL('../public/env-boot-v1.js', import.meta.url), 'utf8')
const originalFetch = globalThis.fetch

function setup({ pathname = '/', search = '', protocol = 'https:', fetchMock } = {}) {
  const location = { pathname, search, protocol }
  globalThis.window = { location, addEventListener: vi.fn() }
  globalThis.document = { addEventListener: vi.fn(), hidden: false }
  globalThis.EventSource = class {
    addEventListener() {}
  }
  globalThis.fetch =
    fetchMock || vi.fn().mockResolvedValue({ ok: true, json: async () => ({ platform: 'test' }) })
  return () =>
    runInNewContext(source, { window, location, fetch: globalThis.fetch, URLSearchParams, Promise })
}

afterEach(() => {
  delete globalThis.window
  delete globalThis.document
  delete globalThis.EventSource
  globalThis.fetch = originalFetch
})

describe('提前请求运行时环境', () => {
  for (const [pathname, search] of [
    ['/', ''],
    ['/', '?perf=0'],
    ['/share', ''],
    ['/share', '?session=1'],
    ['/', '?pluginLauncher=x']
  ]) {
    it(`复用 ${pathname}${search} 的请求`, async () => {
      const boot = setup({ pathname, search })
      boot()
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(fetch).toHaveBeenCalledWith('/api/env', { cache: 'no-store' })
      const api = await ensureMicaApi()
      expect(api.platform).toBe('test')
      expect(api.shareView).toBe(pathname === '/share')
      expect(fetch).toHaveBeenCalledTimes(1)
    })
  }

  it('静态演示、file 页面及已有桌面接口不提前请求', () => {
    let boot = setup({ search: '?quick-buttons-demo=1' })
    boot()
    expect(fetch).not.toHaveBeenCalled()
    boot = setup({ protocol: 'file:' })
    boot()
    expect(fetch).not.toHaveBeenCalled()
    boot = setup()
    window.mica = { existing: true }
    boot()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('主模块先启动时只发送原请求，迟到的脚本不重复请求', async () => {
    const boot = setup()
    const api = ensureMicaApi()
    boot()
    expect((await api).platform).toBe('test')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('主模块复用尚未完成的提前请求', async () => {
    let resolveRequest
    const boot = setup({
      fetchMock: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveRequest = resolve
          })
      )
    })
    boot()
    const api = ensureMicaApi()
    expect(fetch).toHaveBeenCalledTimes(1)
    resolveRequest({ ok: true, json: async () => ({ platform: 'pending' }) })
    expect((await api).platform).toBe('pending')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('脚本没有加载时沿用原请求', async () => {
    setup()
    expect((await ensureMicaApi()).platform).toBe('test')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('保留 403 错误以及失败后重试行为', async () => {
    const boot = setup({
      fetchMock: vi
        .fn()
        .mockResolvedValueOnce({ status: 403, ok: false })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ platform: 'retry' }) })
    })
    boot()
    await expect(ensureMicaApi()).rejects.toBeInstanceOf(AccessDeniedError)
    expect((await ensureMicaApi()).platform).toBe('retry')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('保留网络和 JSON 解析错误', async () => {
    const networkError = new Error('network failed')
    let boot = setup({ fetchMock: vi.fn().mockRejectedValue(networkError) })
    boot()
    await expect(ensureMicaApi()).rejects.toBe(networkError)
    const jsonError = new Error('invalid JSON')
    boot = setup({
      fetchMock: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw jsonError
        }
      })
    })
    boot()
    await expect(ensureMicaApi()).rejects.toBe(jsonError)
  })

  it('保留同步请求异常及非 403 的 HTTP 错误', async () => {
    const error = new Error('fetch unavailable')
    let boot = setup({
      fetchMock: vi.fn(() => {
        throw error
      })
    })
    boot()
    await expect(ensureMicaApi()).rejects.toBe(error)
    boot = setup({ fetchMock: vi.fn().mockResolvedValue({ status: 500, ok: false }) })
    boot()
    await expect(ensureMicaApi()).rejects.toThrow('无法连接 Mica Code 服务端')
  })
})
