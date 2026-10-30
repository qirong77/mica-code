import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  loadManifestSkills,
  readPublishedPluginSkills
} from '@packages/mica-plugin/PluginSkills.js'
import { parsePluginManifest } from '@packages/mica-plugin/PluginManifest.js'
import { PLUGIN_STATE_FILE, readDisabledPluginIds } from '@packages/mica-plugin/PluginState.js'

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
 *
 * 索引只在插件真的 setup 过一次之后才存在。为了让人第一次打开就能在 `/` 里看见随包 skill，
 * 这里**再读一遍清单**（`$MICA_HOME/plugins/<dir>/plugin.json` 的 `skills`）：只解析 JSON、
 * 不导入插件代码——列个名字不该 setup 插件。两边按名字合并，索引在前（运行期才是事实，
 * 它已经处理过「被同名磁盘 skill 遮蔽」这件事）。
 *
 * 每条候选都带 `source`（来源标记）：用户要能一眼看出「这是我自己目录里的，还是插件带的」，
 * 同名 skill 又恰好是磁盘优先，不标就没法解释为什么改了插件里的文件却不生效。
 */

const MAX_SKILLS = 200
const MAX_DESCRIPTION = 160

function micaHome() {
  return process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : join(homedir(), '.mica')
}

/**
 * 扫描目录与它的来源标记。
 *
 * `label` 是浮层里那枚小标记的文字，取相对形态而不是绝对路径：项目级目录写成
 * `.mica/skills`，用户级写成 `$MICA_HOME/skills`——两者在列表里同时出现时，靠这几个字
 * 就能分清「项目里那份」和「家里的那份」。完整路径留在 `detail` 里给悬停用。
 */
export function skillDirEntries(cwd) {
  const entries = []
  if (typeof cwd === 'string' && cwd.trim()) {
    const root = resolve(cwd)
    for (const relative of [
      '.mica/skills',
      '.agents/skills',
      '.deveco/skills',
      '.agent_context/skills'
    ]) {
      entries.push({
        dir: join(root, relative),
        source: { kind: 'project', label: relative }
      })
    }
  }
  entries.push({
    dir: join(micaHome(), 'skills'),
    source: { kind: 'user', label: '$MICA_HOME/skills' }
  })
  if (!process.env.MICA_HOME) {
    entries.push(
      {
        dir: join(homedir(), '.agents', 'skills'),
        source: { kind: 'user', label: '~/.agents/skills' }
      },
      {
        dir: join(homedir(), '.config', 'deveco', 'skills'),
        source: { kind: 'user', label: '~/.config/deveco/skills' }
      }
    )
  }
  return entries
}

/** 只要目录的调用方用它；来源标记在 `skillDirEntries` 里。 */
export function skillDirs(cwd) {
  return skillDirEntries(cwd).map((entry) => entry.dir)
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

  for (const { dir, source } of skillDirEntries(cwd)) {
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
        description: truncateDescription(fields.description),
        source
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
    // 插件 id 带 `user.` 前缀（用户插件与官方插件共用一套索引），标记上只留可读的那半。
    source: {
      kind: 'plugin',
      label: `插件 ${skill.pluginId.replace(/^user\./, '')}`,
      detail: skill.pluginId
    }
  }))
}

/**
 * 清单声明的 skill：插件目录里那些，**不用等它 setup 一次**。
 *
 * 只读 `plugin.json` 与 `SKILL.md`，不导入入口文件。停用的插件照样跳过（`plugins-state.json`
 * 是用户的选择，不是加载时机问题）。
 */
function declaredSkills() {
  const pluginsDir = join(micaHome(), 'plugins')
  if (!existsSync(pluginsDir)) return []
  const disabled = new Set(readDisabledPluginIds({ path: join(micaHome(), PLUGIN_STATE_FILE) }))
  let entries = []
  try {
    entries = readdirSync(pluginsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const skills = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const root = join(pluginsDir, entry.name)
    const manifestFile = join(root, 'plugin.json')
    if (!existsSync(manifestFile)) continue
    let manifest
    try {
      const parsed = parsePluginManifest(JSON.parse(readFileSync(manifestFile, 'utf-8')))
      if (!parsed.ok) continue
      manifest = parsed.manifest
    } catch {
      continue
    }
    // 运行期 id 带 `user.` 前缀（文件加载器统一加），停用名单按它记。
    const pluginId = `user.${manifest.id}`
    if (disabled.has(pluginId) || manifest.skills.length === 0) continue
    const loaded = loadManifestSkills(root, manifest.skills)
    for (const skill of loaded.skills) {
      skills.push({
        name: skill.name,
        path: join(skill.baseDir, 'SKILL.md'),
        description: truncateDescription(skill.description),
        // 与索引那条用同一个写法，否则同一个 skill 在「跑过会话前后」会换一个标记
        source: { kind: 'plugin', label: `插件 ${manifest.id}`, detail: pluginId }
      })
    }
  }
  return skills
}

export function listSkills(cwd) {
  const skills = scanDiskSkills(cwd)
  const seen = new Set(skills.map((skill) => skill.name))

  for (const skill of [...publishedSkills(), ...declaredSkills()]) {
    if (skills.length >= MAX_SKILLS) break
    if (seen.has(skill.name)) continue
    seen.add(skill.name)
    skills.push(skill)
  }

  return skills.sort(byName)
}
