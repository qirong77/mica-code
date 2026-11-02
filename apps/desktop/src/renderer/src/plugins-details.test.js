import { afterEach, describe, expect, test } from 'bun:test'
import { readPluginsDetails } from './plugins-details'

const stubTransport = (invoke) => {
  globalThis.window = { mica: { configWeb: { invoke } } }
}

afterEach(() => {
  delete globalThis.window
})

describe('readPluginsDetails', () => {
  test('启动期一次失败后自己重试，读到清单就不再返回空', async () => {
    let calls = 0
    stubTransport(async () => {
      calls += 1
      if (calls < 3) throw new Error('请求失败 (HTTP 401)')
      return { plugins: [{ id: 'user.demand-dev' }] }
    })
    const plugins = await readPluginsDetails({ force: true })
    expect(plugins.map((plugin) => plugin.id)).toEqual(['user.demand-dev'])
    expect(calls).toBe(3)
  })

  test('重试用尽后失败不进缓存，下一次调用重新问运行时', async () => {
    let calls = 0
    stubTransport(async () => {
      calls += 1
      if (calls <= 3) throw new Error('请求失败 (HTTP 401)')
      return { plugins: [{ id: 'user.demand-dev' }] }
    })
    expect(await readPluginsDetails({ force: true })).toEqual([])
    expect(calls).toBe(3)
    // 失败那次没有写进缓存，所以下一次调用应当真的再问一次而不是拿空数组。
    const plugins = await readPluginsDetails()
    expect(plugins.map((plugin) => plugin.id)).toEqual(['user.demand-dev'])
    expect(calls).toBe(4)
  })

  test('确实没有插件时返回空清单，并照常缓存', async () => {
    let calls = 0
    stubTransport(async () => {
      calls += 1
      return { plugins: [] }
    })
    expect(await readPluginsDetails({ force: true })).toEqual([])
    expect(await readPluginsDetails()).toEqual([])
    expect(calls).toBe(1)
  })
})
