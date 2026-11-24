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
  it('官方插件声明的文档在候选里，指向运行时自己的接口根', () => {
    const entry = listPluginUriApis('').find((item) => item.name === 'notebook')
    expect(entry).toMatchObject({
      pluginId: 'notebook',
      uri: '/plugin/notebook/api',
      source: { kind: 'plugin', label: 'notebook', detail: 'notebook' }
    })
  })

  it('把「不常用的能力」都收在按需文档里：排期与视频同样只留一条 URI', () => {
    const entries = listPluginUriApis('')
    for (const [name, uri] of [
      ['notebook', '/plugin/notebook/api'],
      ['schedule', '/plugin/schedule/api'],
      ['video', '/plugin/video/api']
    ]) {
      const entry = entries.find((item) => item.name === name)
      expect(entry).toMatchObject({ uri, source: { kind: 'plugin', label: name } })
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
    writePlugin('notebook', {
      uriApis: [
        {
          name: 'notebook',
          description: '我自己的',
          uri: 'https://mica.qirong77.com/plugin/notebook/api'
        }
      ]
    })
    const entries = listPluginUriApis('').filter((entry) => entry.name === 'notebook')
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      description: '我自己的',
      uri: 'https://mica.qirong77.com/plugin/notebook/api'
    })
  })
})
