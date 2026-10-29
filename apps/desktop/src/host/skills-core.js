import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { readPublishedPluginSkills } from '@packages/mica-plugin/PluginSkills.js'

/**
 * 聊天输入框 `/` 补全的 skill 候选数据源。
 *
 * 桌面运行时同时服务多个工作目录的会话，所以目录集合按调用方给的 cwd 现算；口径与 CLI 的
 * skills 扫描一致（项目级四个目录 + 用户级 $MICA_HOME/skills）。只读、只取 name/description，
 * 不做缓存——用户改完 SKILL.md 立刻可见。
 *
 * 用户目录之外还有**内置 skill**（插件随包分发的正文，如 computer-use）：它们不在任何
 * 目录里，靠插件系统注册时落盘的索引扫出来（`$MICA_HOME/plugin-skills/<pluginId>.json`）。
 * 与运行期注册表同一条规则——磁盘上的同名 skill 优先，插件不抢用户的名字。
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

function truncateDescription(text) {
  const description = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return description.length > MAX_DESCRIPTION ? description.slice(0, MAX_DESCRIPTION) : description
}

function scanDiskSkills(cwd) {
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

      skills.push({
        name,
        // 输入框选中所插入的就是这条绝对路径，所以扫描时直接带出去，渲染层不自己拼。
        path: skillFile,
        description: truncateDescription(fields.description)
      })
      if (skills.length >= MAX_SKILLS) return skills
    }
  }

  return skills
}

/**
 * 插件发布的内置 skill。
 *
 * 索引里已经是最新生效的那几条（停用的插件、正文文件不在了的条目在读的时候就被剔掉），
 * 所以这里只做形状转换；`builtin: true` 让浮层标出「内置」，用户据此知道它不来自磁盘。
 */
function publishedSkills() {
  return readPublishedPluginSkills({ configDir: micaHome() }).map((skill) => ({
    name: skill.name,
    path: skill.path,
    description: truncateDescription(skill.description),
    builtin: true
  }))
}

export function listSkills(cwd) {
  const skills = scanDiskSkills(cwd)
  const seen = new Set(skills.map((skill) => skill.name))

  for (const skill of publishedSkills()) {
    if (skills.length >= MAX_SKILLS) break
    if (seen.has(skill.name)) continue
    seen.add(skill.name)
    skills.push(skill)
  }

  return skills.sort(byName)
}
