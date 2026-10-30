import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listSkills, parseSkillFrontmatter, skillDirs } from './skills-core'

const previousHome = process.env.MICA_HOME
let base
let home
let project

function writeSkill(directory, name, content) {
  const dir = join(directory, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8')
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mica-skills-'))
  home = join(base, 'home')
  project = join(base, 'project')
  mkdirSync(home, { recursive: true })
  mkdirSync(project, { recursive: true })
  process.env.MICA_HOME = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.MICA_HOME
  else process.env.MICA_HOME = previousHome
  if (base && existsSync(base)) rmSync(base, { recursive: true, force: true })
})

describe('host skill scanning', () => {
  it('collects project and user skills with their frontmatter metadata', () => {
    writeSkill(
      join(project, '.mica', 'skills'),
      'ask',
      '---\nname: ask\ndescription: Ask the code author\n---\n\nbody\n'
    )
    writeSkill(join(home, 'skills'), 'cooper', '---\ndescription: Cooper docs\n---\n')

    const skills = listSkills(project)
    expect(skills.map((skill) => skill.name)).toEqual(['ask', 'cooper'])
    expect(skills[0].description).toBe('Ask the code author')
    // 缺 frontmatter name 时用目录名
    expect(skills[1].description).toBe('Cooper docs')
  })

  it('falls back to the directory name and ignores directories without SKILL.md', () => {
    writeSkill(join(home, 'skills'), 'plain', 'just a body\n')
    mkdirSync(join(home, 'skills', 'empty'), { recursive: true })
    writeFileSync(join(home, 'skills', 'loose.md'), 'nope', 'utf-8')

    expect(listSkills(null)).toEqual([
      {
        name: 'plain',
        path: join(home, 'skills', 'plain', 'SKILL.md'),
        description: '',
        source: { kind: 'user', label: '$MICA_HOME/skills' }
      }
    ])
  })

  it('lists built-in skills published by plugins, and lets disk skills win', () => {
    // 插件注册的内置 skill：正文随包落到 $MICA_HOME/computer-use，索引由插件系统写
    const builtinDir = join(home, 'computer-use')
    mkdirSync(builtinDir, { recursive: true })
    writeFileSync(join(builtinDir, 'SKILL.md'), '---\nname: computer-use\n---\n', 'utf-8')
    const indexDir = join(home, 'plugin-skills')
    mkdirSync(indexDir, { recursive: true })
    writeFileSync(
      join(indexDir, 'computer-use.json'),
      JSON.stringify({
        pluginId: 'computer-use',
        skills: [
          {
            name: 'computer-use',
            description: '操作 macOS 桌面',
            path: join(builtinDir, 'SKILL.md')
          }
        ]
      }),
      'utf-8'
    )
    writeSkill(join(home, 'skills'), 'cooper', '---\ndescription: Cooper docs\n---\n')

    const skills = listSkills(null)
    expect(skills.map((skill) => skill.name)).toEqual(['computer-use', 'cooper'])
    // 来源标记说清它是插件带的，而不是用户目录里的某个文件
    expect(skills[0]).toEqual({
      name: 'computer-use',
      path: join(builtinDir, 'SKILL.md'),
      description: '操作 macOS 桌面',
      source: { kind: 'plugin', label: '插件 computer-use', detail: 'computer-use' }
    })

    // 用户装一份同名 skill：磁盘优先，插件不抢名字（与运行期注册表同一规则）
    writeSkill(join(home, 'skills'), 'computer-use', '---\ndescription: mine\n---\n')
    const shadowed = listSkills(null).filter((skill) => skill.name === 'computer-use')
    expect(shadowed).toEqual([
      {
        name: 'computer-use',
        path: join(home, 'skills', 'computer-use', 'SKILL.md'),
        description: 'mine',
        source: { kind: 'user', label: '$MICA_HOME/skills' }
      }
    ])
  })

  it('keeps the project skill when a user skill has the same name', () => {
    writeSkill(join(project, '.agent_context', 'skills'), 'dup', '---\nname: dup\n---\n')
    writeSkill(join(home, 'skills'), 'dup', '---\nname: dup\ndescription: user copy\n---\n')

    const skills = listSkills(project)
    expect(skills).toHaveLength(1)
    expect(skills[0].description).toBe('')
  })

  it("lists a plugin's declared skills before it was ever set up", () => {
    // 索引只有插件 setup 过才存在。第一次打开 `/` 也要能看见随包 skill，
    // 所以这里只放清单与文件、不放 plugin-skills 索引。
    const pluginRoot = join(home, 'plugins', 'demand-dev')
    writeSkill(
      join(pluginRoot, 'skills'),
      'demand-verify',
      '---\nname: demand-verify\ndescription: 联调验收\n---\n'
    )
    writeFileSync(
      join(pluginRoot, 'plugin.json'),
      JSON.stringify({
        id: 'demand-dev',
        name: 'Demand Dev',
        version: '1.0.0',
        skills: ['skills']
      }),
      'utf-8'
    )

    const skills = listSkills(null)
    expect(skills).toEqual([
      {
        name: 'demand-verify',
        path: join(pluginRoot, 'skills', 'demand-verify', 'SKILL.md'),
        description: '联调验收',
        // 标记与索引那条同写法，跑过会话前后不会换一个
        source: { kind: 'plugin', label: '插件 demand-dev', detail: 'user.demand-dev' }
      }
    ])
  })

  it('respects the disabled list for declared plugin skills', () => {
    const pluginRoot = join(home, 'plugins', 'demo')
    writeSkill(join(pluginRoot, 'skills'), 'quiet', '---\nname: quiet\n---\n')
    writeFileSync(
      join(pluginRoot, 'plugin.json'),
      JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0', skills: ['skills'] }),
      'utf-8'
    )
    writeFileSync(
      join(home, 'plugins-state.json'),
      JSON.stringify({ disabled: ['user.demo'] }),
      'utf-8'
    )

    expect(listSkills(null)).toEqual([])
  })

  it('includes the cwd skill dirs only when a cwd is given', () => {
    expect(skillDirs(null).some((dir) => dir.includes(project))).toBe(false)
    expect(skillDirs(project)[0]).toBe(join(project, '.mica', 'skills'))
  })

  it('folds multi-line frontmatter values into one line', () => {
    const fields = parseSkillFrontmatter(
      '---\nname: folded\ndescription: >\n  line one\n  line two\n---\n'
    )
    expect(fields).toEqual({ name: 'folded', description: 'line one line two' })
  })
})
