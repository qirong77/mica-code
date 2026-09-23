import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

/**
 * 聊天输入框 `/` 补全的 skill 候选数据源。
 *
 * 桌面运行时同时服务多个工作目录的会话，所以目录集合按调用方给的 cwd 现算；口径与 CLI 的
 * skills 扫描一致（项目级四个目录 + 用户级 $MICA_HOME/skills）。只读、只取 name/description，
 * 不做缓存——用户改完 SKILL.md 立刻可见。
 */

const MAX_SKILLS = 200
const MAX_DESCRIPTION = 160

function micaHome() {
  return process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : join(homedir(), '.mica')
}

export function skillDirs(cwd) {
  const dirs = []
  if (typeof cwd === 'string' && cwd.trim()) {
    const root = resolve(cwd)
    dirs.push(
      join(root, '.mica', 'skills'),
      join(root, '.agents', 'skills'),
      join(root, '.deveco', 'skills'),
      join(root, '.agent_context', 'skills')
    )
  }
  dirs.push(join(micaHome(), 'skills'))
  if (!process.env.MICA_HOME) {
    dirs.push(join(homedir(), '.agents', 'skills'), join(homedir(), '.config', 'deveco', 'skills'))
  }
  return dirs
}

export function parseSkillFrontmatter(raw) {
  const trimmed = String(raw ?? '').trimStart()
  if (!trimmed.startsWith('---')) return {}
  const bodyStart = trimmed.indexOf('\n', 3)
  if (bodyStart === -1) return {}
  const endMarker = trimmed.indexOf('\n---', bodyStart)
  if (endMarker === -1) return {}

  const fields = {}
  let currentKey = ''
  for (const rawLine of trimmed.slice(bodyStart, endMarker).split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) {
      // 折叠值（`description: >` 之类）的后续行接到上一个键上。
      if (currentKey && typeof fields[currentKey] === 'string') {
        fields[currentKey] = `${fields[currentKey]} ${line}`.trim()
      }
      continue
    }
    currentKey = match[1].toLowerCase()
    const value = match[2].trim().replace(/^["']|["']$/g, '')
    // `description: >` / `description: |` 的正文在后续行里。
    fields[currentKey] = /^[>|][+-]?$/.test(value) ? '' : value
  }
  return fields
}

function byName(a, b) {
  return a.name.localeCompare(b.name)
}

export function listSkills(cwd) {
  const seen = new Set()
  const skills = []

  for (const dir of skillDirs(cwd)) {
    if (!existsSync(dir)) continue
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const baseDir = join(dir, entry.name)
      const skillFile = join(baseDir, 'SKILL.md')
      if (!existsSync(skillFile)) continue

      let content = ''
      try {
        content = readFileSync(skillFile, 'utf-8')
      } catch {
        continue
      }
      const fields = parseSkillFrontmatter(content)
      const name = String(fields.name || basename(baseDir)).trim()
      if (!name || seen.has(name)) continue
      seen.add(name)

      const description = String(fields.description ?? '')
        .replace(/\s+/g, ' ')
        .trim()
      skills.push({
        name,
        description:
          description.length > MAX_DESCRIPTION ? description.slice(0, MAX_DESCRIPTION) : description
      })
      if (skills.length >= MAX_SKILLS) return skills.sort(byName)
    }
  }

  return skills.sort(byName)
}

