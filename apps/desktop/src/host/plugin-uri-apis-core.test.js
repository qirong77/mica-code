import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listPluginUriApis } from './plugin-uri-apis-core'

/**
 * `/` 里「API 文档」那一类：只读清单就能列出来（不用启动插件）。盯住四件事——
 * 官方清单在、用户插件读得到、停用/角色的过滤生效、同名时用户插件优先。
 */

const previousHome = process.env.MICA_HOME
let base
let home

function writePlugin(id, manifest) {
  const dir = join(home, 'plugins', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({ id, name: id, version: '1.0.0', ...manifest })
  )
}

function writeState(disabled) {
  writeFileSync(join(home, 'plugins-state.json'), JSON.stringify({ disabled }))
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mica-uri-apis-'))
  home = join(base, 'home')
  mkdirSync(home, { recursive: true })
  process.env.MICA_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.MICA_HOME
  else process.env.MICA_HOME = previousHome
  if (base && existsSync(base)) rmSync(base, { recursive: true, force: true })
})

describe('插件的按需 URI 文档', () => {
  it('列出官方插件声明的 URI 与来源', () => {
    const entries = listPluginUriApis('')
    for (const name of ['schedule', 'video']) {
      expect(entries.find((item) => item.name === name)).toMatchObject({
        pluginId: name, uri: `/plugin/${name}/api`, source: { kind: 'plugin', label: name, detail: name }
      })
    }
  })

  it('读用户插件清单里的条目，来源标出插件 id', () => {
    writePlugin('demand-dev', {
      uriApis: [
        {
          name: 'demand-api',
          description: '需求台账的机读接口',
          uri: '/plugin/demand-dev/api'
        }
      ]
    })

    const entry = listPluginUriApis('').find((item) => item.name === 'demand-api')
    expect(entry).toMatchObject({
      description: '需求台账的机读接口',
      uri: '/plugin/demand-dev/api',
      source: { kind: 'plugin', label: 'demand-dev', detail: 'user.demand-dev' }
    })
  })

  it('停用的插件不出现', () => {
    writePlugin('demo', { uriApis: [{ name: 'demo-api', uri: '/plugin/demo/api' }] })
    writeState(['user.demo'])
    expect(listPluginUriApis('').some((entry) => entry.name === 'demo-api')).toBe(false)
  })

  it('声明了角色的文档只在那个角色下出现', () => {
    writePlugin('demo', {
      uriApis: [{ name: 'scoped-api', uri: '/plugin/demo/api', roles: ['需求开发'] }]
    })
    expect(listPluginUriApis('需求开发').some((entry) => entry.name === 'scoped-api')).toBe(true)
    expect(listPluginUriApis('').some((entry) => entry.name === 'scoped-api')).toBe(false)
  })

  it('同名文档用户插件优先：本地跑着的接口比随包的更贴近手头的数据', () => {
    writePlugin('schedule', {
      uriApis: [
        {
          name: 'schedule',
          description: '我自己的',
          uri: 'https://example.test/plugin/schedule/api'
        }
      ]
    })
    const entries = listPluginUriApis('').filter((entry) => entry.name === 'schedule')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      description: '我自己的',
      uri: 'https://example.test/plugin/schedule/api'
    })
  })
})
