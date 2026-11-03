import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listPluginCompletions } from './plugin-completions-core'

/**
 * `/` 里插件挂的条目：只读清单就能列出来（不用启动插件）。所以这里盯住三件事——
 * 用户插件读得到、停用/角色的过滤生效、官方清单也在这条路上。
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
  base = mkdtempSync(join(tmpdir(), 'mica-completions-'))
  home = join(base, 'home')
  mkdirSync(home, { recursive: true })
  process.env.MICA_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.MICA_HOME
  else process.env.MICA_HOME = previousHome
  if (base && existsSync(base)) rmSync(base, { recursive: true, force: true })
})

describe('插件补全候选', () => {
  it('读用户插件清单里的条目，来源标出插件 id', () => {
    writePlugin('demand-dev', {
      completions: [
        { name: 'role', description: '记一条经验', insert: '用 demand_role 写回：' },
        { name: 'issue', description: '', insert: '用 demand_issue action=list 看台账' }
      ]
    })

    const entries = listPluginCompletions('需求开发').filter(
      (entry) => entry.name === 'role' || entry.name === 'issue'
    )
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      name: 'role',
      insert: '用 demand_role 写回：',
      source: { kind: 'plugin', label: '插件 demand-dev', detail: 'user.demand-dev' }
    })
  })

  it('停用的插件不出现', () => {
    writePlugin('demo', { completions: [{ name: 'demo-entry', insert: 'x' }] })
    writeState(['user.demo'])
    expect(listPluginCompletions('').some((entry) => entry.name === 'demo-entry')).toBe(false)
  })

  it('声明了角色的条目只在那个角色下出现', () => {
    writePlugin('demo', {
      completions: [{ name: 'scoped-entry', insert: 'x', roles: ['需求开发'] }]
    })
    expect(listPluginCompletions('需求开发').some((entry) => entry.name === 'scoped-entry')).toBe(
      true
    )
    expect(listPluginCompletions('default').some((entry) => entry.name === 'scoped-entry')).toBe(
      false
    )
  })

  it('同一个名字只留一条（用户插件排在官方前面）', () => {
    writePlugin('demo', { completions: [{ name: 'dup-entry', insert: 'user' }] })
    const entries = listPluginCompletions('').filter((entry) => entry.name === 'dup-entry')
    expect(entries).toHaveLength(1)
    expect(entries[0].insert).toBe('user')
  })

  it('坏清单与没有 plugin.json 的目录都跳过，不影响别的候选', () => {
    writePlugin('good', { completions: [{ name: 'good-entry', insert: 'x' }] })
    mkdirSync(join(home, 'plugins', 'broken'), { recursive: true })
    writeFileSync(join(home, 'plugins', 'broken', 'plugin.json'), '{ not json')
    mkdirSync(join(home, 'plugins', 'loose'), { recursive: true })
    writeFileSync(join(home, 'plugins', 'loose', 'index.js'), 'export default () => {}')

    const names = listPluginCompletions('').map((entry) => entry.name)
    expect(names).toContain('good-entry')
    expect(names).not.toContain('broken')
  })
})
