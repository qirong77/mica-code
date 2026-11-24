import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { AccessDeniedError, ensureMicaApi, startupUiStateApi } from './transport.js'

const source = readFileSync(new URL('../public/runtime-boot-v2.js', import.meta.url), 'utf8')
const originalFetch = globalThis.fetch
const sharedSnapshot = { workspace: { activeId: 'demo' } }
const envResponse = (platform = 'test') => ({ ok: true, json: async () => ({ platform }) })
const uiStateResponse = () => ({ ok: true, json: async () => ({ ok: true, result: sharedSnapshot }) })

function setup({ pathname = '/', search = '', protocol = 'https:', envFetch = async () => envResponse() } = {}) {
  const location = { pathname, search, protocol }
  globalThis.window = { location, addEventListener: vi.fn() }
  globalThis.document = { addEventListener: vi.fn(), hidden: false }
  globalThis.EventSource = class {}
  globalThis.fetch = vi.fn((url) => url === '/api/env' ? envFetch() : Promise.resolve(uiStateResponse()))
  return () => runInNewContext(source, { window, location, fetch: globalThis.fetch, URLSearchParams, Promise })
}

afterEach(() => {
  delete globalThis.window
  delete globalThis.document
  delete globalThis.EventSource
  globalThis.fetch = originalFetch
})

describe('并行请求运行时环境与共享界面状态', () => {
  for (const [pathname, search] of [['/', ''], ['/share', ''], ['/share', '?session=1'], ['/', '?pluginLauncher=x']]) {
    it(`复用 ${pathname}${search} 的两条提前请求`, async () => {
      const boot = setup({ pathname, search })
      boot()
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(fetch).toHaveBeenCalledWith('/api/env', { cache: 'no-store' })
      expect(fetch).toHaveBeenCalledWith('/api/invoke', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"channel":"ui-state:get"}'
      })
      expect(await startupUiStateApi().get()).toEqual(sharedSnapshot)
      const api = await ensureMicaApi()
      expect(api.platform).toBe('test')
      expect(api.shareView).toBe(pathname === '/share')
      expect(fetch).toHaveBeenCalledTimes(2)
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
    const uiState = { existing: true }
    window.mica = { uiState }
    boot()
    expect(startupUiStateApi()).toBe(uiState)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('主模块先启动时并行请求，迟到的脚本不重复请求', async () => {
    let resolveEnv
    const boot = setup({ envFetch: () => new Promise((resolve) => { resolveEnv = resolve }) })
    const uiState = startupUiStateApi().get()
    const api = ensureMicaApi()
    boot()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(await uiState).toEqual(sharedSnapshot)
    resolveEnv(envResponse('pending'))
    expect((await api).platform).toBe('pending')
  })

  it('主模块复用在途请求；SSE 恢复不再次消费初始响应', async () => {
    let resolveEnv
    const boot = setup({ envFetch: () => new Promise((resolve) => { resolveEnv = resolve }) })
    boot()
    const uiState = startupUiStateApi()
    const api = ensureMicaApi()
    expect(await uiState.get()).toEqual(sharedSnapshot)
    expect(fetch).toHaveBeenCalledTimes(2)
    resolveEnv(envResponse('pending'))
    expect((await api).platform).toBe('pending')
    expect(await uiState.get()).toEqual(sharedSnapshot)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('保留 403 错误以及失败后重试行为', async () => {
    const envFetch = vi.fn().mockResolvedValueOnce({ status: 403, ok: false }).mockResolvedValueOnce(envResponse('retry'))
    setup({ envFetch })()
    await expect(ensureMicaApi()).rejects.toBeInstanceOf(AccessDeniedError)
    expect((await ensureMicaApi()).platform).toBe('retry')
    expect(envFetch).toHaveBeenCalledTimes(2)
  })

  it('保留网络、JSON 解析错误和同步请求异常', async () => {
    const networkError = new Error('network failed')
    setup({ envFetch: async () => { throw networkError } })()
    await expect(ensureMicaApi()).rejects.toBe(networkError)
    const jsonError = new Error('invalid JSON')
    setup({ envFetch: async () => ({ ok: true, json: async () => { throw jsonError } }) })()
    await expect(ensureMicaApi()).rejects.toBe(jsonError)
    const syncError = new Error('fetch unavailable')
    setup({ envFetch: () => { throw syncError } })()
    await expect(ensureMicaApi()).rejects.toBe(syncError)
    setup({ envFetch: async () => ({ status: 500, ok: false }) })()
    await expect(ensureMicaApi()).rejects.toThrow('无法连接 Mica Code 服务端')
  })
})
