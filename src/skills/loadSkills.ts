import { readdirSync, readFileSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Skill } from './types.js'

function getUserSkillsDirs(): string[] {
  return [
    join(homedir(), '.mica', 'skills'),
    join(homedir(), '.claude', 'skills'),
  ]
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; content: string } {
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, content: raw }
  }
  const secondNewline = trimmed.indexOf('\n', 3)
  if (secondNewline === -1) {
    return { frontmatter: {}, content: raw }
  }
  const endMarker = trimmed.indexOf('\n---', secondNewline)
  if (endMarker === -1) {
    return { frontmatter: {}, content: raw }
  }
  const fmText = trimmed.slice(4, endMarker).trim()
  const body = trimmed.slice(endMarker + 4).trimStart()

  const frontmatter: Record<string, unknown> = {}
  let currentKey = ''
  let currentList: string[] = []
  let inList = false

  for (const rawLine of fmText.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue

    const listMatch = line.match(/^\s*-\s+(.*)$/)
    if (listMatch) {
      if (currentKey) {
        currentList.push(listMatch[1].trim())
        inList = true
      }
      continue
    }

    if (inList && currentKey) {
      frontmatter[currentKey] = currentList
      currentList = []
      inList = false
    }

    const kvMatch = line.match(/^([a-zA-Z_-][a-zA-Z0-9_-]*)\s*:\s*(.*)$/)
    if (kvMatch) {
      currentKey = kvMatch[1]
      const value = kvMatch[2].trim()

      if (value === '') {
        frontmatter[currentKey] = value
        currentList = []
        continue
      }

      if (value === 'true') {
        frontmatter[currentKey] = true
        continue
      }
      if (value === 'false') {
        frontmatter[currentKey] = false
        continue
      }

      const quoted = value.match(/^["'](.*)["']$/)
      frontmatter[currentKey] = quoted ? quoted[1] : value
    }
  }

  if (inList && currentKey) {
    frontmatter[currentKey] = currentList
  }

  return { frontmatter, content: body }
}

function loadSkillFromDir(skillDir: string, name: string): Skill | null {
  const skillFilePath = join(skillDir, 'SKILL.md')
  if (!existsSync(skillFilePath)) return null

  try {
    const raw = readFileSync(skillFilePath, 'utf-8')
    const { frontmatter, content } = parseFrontmatter(raw)

    return {
      name: String(frontmatter.name || name),
      description: String(frontmatter.description || name),
      whenToUse: frontmatter.when_to_use as string | undefined,
      argumentHint: frontmatter['argument-hint'] as string | undefined,
      content,
      baseDir: skillDir,
    }
  } catch {
    return null
  }
}

let _loadedSkills: Skill[] | null = null

export function getLoadedSkills(): Skill[] {
  if (_loadedSkills === null) {
    _loadedSkills = []
    const seen = new Set<string>()

    for (const skillsDir of getUserSkillsDirs()) {
      if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) {
        continue
      }

      try {
        const entries = readdirSync(skillsDir)
        for (const entry of entries) {
          if (seen.has(entry)) continue
          const fullPath = join(skillsDir, entry)
          if (statSync(fullPath).isDirectory()) {
            const skill = loadSkillFromDir(fullPath, entry)
            if (skill) {
              _loadedSkills.push(skill)
              seen.add(entry)
            }
          }
        }
      } catch {
        // silently skip
      }
    }
  }
  return _loadedSkills
}

export function reloadSkills(): Skill[] {
  _loadedSkills = null
  return getLoadedSkills()
}
