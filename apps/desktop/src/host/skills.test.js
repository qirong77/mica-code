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

    expect(listSkills(null)).toEqual([{ name: 'plain', description: '' }])
  })

  it('keeps the project skill when a user skill has the same name', () => {
    writeSkill(join(project, '.agent_context', 'skills'), 'dup', '---\nname: dup\n---\n')
    writeSkill(join(home, 'skills'), 'dup', '---\nname: dup\ndescription: user copy\n---\n')

    const skills = listSkills(project)
    expect(skills).toHaveLength(1)
    expect(skills[0].description).toBe('')
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
