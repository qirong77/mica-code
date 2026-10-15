import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import {
  buildConfigWebConversationItems,
  buildConfigWebContextAnalysis
} from '@mica-config-ui/session-view'
// 内置 default role 与 CLI 同源：提示词模板就是 packages/mica-agent/prompt/system.md，
// 展开品牌占位符后原样展示（只读），桌面宿主不自己留一份副本。
import defaultSystemPromptTemplate from '@packages/mica-agent/prompt/system.md?raw'
import { applyBrandTemplate } from '@packages/mica-agent/prompt/brandTemplate.js'
import {
  getAutoCompactSnapshot,
  resetAutoCompactCounters as resetAutoCompactCountersInStore,
  saveAutoCompactSettings
} from './auto-compact.js'
import { DEFAULT_AUTO_COMPACT_SETTINGS } from './auto-compact-state.js'
import {
  closeBrowserControlWindow as closeBrowserWindow,
  createBrowserControlWindow as createBrowserWindow,
  hideBrowserControlWindow as hideBrowserWindow,
  readBrowserControlDetails as readBrowserControlDetailsFromHost,
  showBrowserControlWindow as showBrowserWindow
} from './browser-control.js'

/**
 * 配置页在桌面运行时的数据层。
 *
 * 直接读写本机的 `$MICA_HOME`（config.json / role / skills / plugins / sessions），不依赖
 * CLI 的那些运行时包 —— 页面组件来自 packages/mica-config-ui，但它引用的数据操作在这里
 * 用最朴素的文件读写实现，和 CLI 侧（apps/config-web 的 server.ts）各自对着一份数据。
 *
 * 唯一的例外是自动压缩：它的设置与计数不在 `$MICA_HOME` 里，而是运行时自己的
 * `userData/auto-compact.json`（host/auto-compact.js 是唯一持有者，这里有它转发）。
 *
 * 受控浏览器同理：窗口活在 Electron 主进程（host/browser-control.js），运行时是纯 Node，
 * 两边只能靠本机 HTTP 服务通信 —— 这里转发读取，并在创建/显示/隐藏/关闭时直接打那套服务。
 *
 * 会话视图的「history → 对话项 / 上下文分解」是纯逻辑，直接复用包里的实现。
 */

function micaHome() {
  return process.env.MICA_HOME ? resolve(process.env.MICA_HOME) : join(homedir(), '.mica')
}

const configPath = () => join(micaHome(), 'config.json')
const sessionsDir = () => join(micaHome(), 'sessions')
const rolesDir = () => join(micaHome(), 'role')
const skillsRoot = () => join(micaHome(), 'skills')
const pluginsRoot = () => join(micaHome(), 'plugins')
const pluginStatusPath = () => join(micaHome(), 'plugin-status.json')

function writeTextAtomic(file, content) {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(temporary, content, 'utf-8')
  renameSync(temporary, file)
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf-8'))
}

/* --------------------------------------------------------------- 配置文件 */

function readConfigFile() {
  if (!existsSync(configPath())) writeTextAtomic(configPath(), '{}\n')
  return { path: configPath(), content: readFileSync(configPath(), 'utf-8') }
}

function writeConfigFile(content) {
  const parsed = JSON.parse(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config.json 必须是 JSON 对象')
  }
  writeTextAtomic(configPath(), `${JSON.stringify(parsed, null, 2)}\n`)
  return readConfigFile()
}

/** 只改 mcpServers 一段，其余字段原样保留 */
function updateMcpServers(mutate) {
  const path = configPath()
  const current = existsSync(path) ? readJson(path) : {}
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error('config.json 不是 JSON 对象')
  }
  const servers = { ...(current.mcpServers ?? {}) }
  mutate(servers)
  writeTextAtomic(path, `${JSON.stringify({ ...current, mcpServers: servers }, null, 2)}\n`)
}

const normalizeMcpName = (name) => {
  const trimmed = String(name ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trimmed)) {
    throw new Error('MCP 名称只允许字母、数字、下划线和连字符')
  }
  return trimmed
}

function parseMcpServerConfig(content, name) {
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(`MCP server ${name} 的配置不是合法 JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`MCP server ${name} 的配置必须是 JSON 对象`)
  }
  if (typeof parsed.url !== 'string' && typeof parsed.command !== 'string') {
    throw new Error(`MCP server ${name} 需要 url 或 command`)
  }
  return parsed
}

function readMcpDetails() {
  const configured = existsSync(configPath()) ? (readJson(configPath()).mcpServers ?? {}) : {}
  return {
    path: configPath(),
    servers: Object.entries(configured).map(([name, config]) => ({
      ...describeMcpConfig(name, config),
      // 桌面端不代管 MCP 连接（它跑在会话进程里），这里只反映配置文件的内容
      status: 'configured',
      toolCount: 0,
      tools: []
    }))
  }
}

function describeMcpConfig(name, config) {
  if ('url' in config) {
    return {
      name,
      type: 'http',
      target: config.url,
      configPath: configPath(),
      config: JSON.stringify(config, null, 2),
      envKeys: config.headers ? Object.keys(config.headers) : []
    }
  }
  return {
    name,
    type: 'stdio',
    target: `${config.command} ${(config.args ?? []).join(' ')}`.trim(),
    configPath: configPath(),
    config: JSON.stringify(config, null, 2),
    cwd: config.cwd,
    envKeys: config.env ? Object.keys(config.env) : []
  }
}

/* ------------------------------------------------------------------- 角色 */

function readRoleFile(name) {
  const path = join(rolesDir(), `${name}.md`)
  return existsSync(path) ? readFileSync(path, 'utf-8') : null
}

function listRoles() {
  const directory = rolesDir()
  const files = existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
        .filter(
          (entry) =>
            entry.isFile() &&
            entry.name.toLowerCase().endsWith('.md') &&
            // 与 CLI 的 roles 扫描一致：用户目录里的 default.md 不能盖掉内置角色
            basename(entry.name, extname(entry.name)) !== 'default'
        )
        .map((entry) => entry.name)
        .sort()
    : []
  return [
    // 内置角色只展示、不可编辑（与 CLI 的约定一致）
    { name: 'default', content: builtInRolePrompt(), builtIn: true, path: null },
    ...files.map((fileName) => ({
      name: basename(fileName, extname(fileName)),
      content: readFileSync(join(directory, fileName), 'utf-8'),
      builtIn: false,
      path: join(directory, fileName)
    }))
  ]
}

const readRolesDetails = () => ({ root: rolesDir(), roles: listRoles() })

/** 内置 default 角色的提示词（品牌占位符已展开），与 CLI 的 roles.get('default') 同一份内容。 */
function builtInRolePrompt() {
  return applyBrandTemplate(defaultSystemPromptTemplate)
}

function normalizeRoleName(name) {
  const trimmed = String(name ?? '')
    .trim()
    .replace(/\.md$/i, '')
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(trimmed)) {
    throw new Error('角色名只允许字母、数字、点、下划线和连字符')
  }
  return trimmed
}

function roleFileOf(name) {
  const normalized = normalizeRoleName(name)
  if (normalized === 'default') throw new Error('内置 default 角色不可编辑')
  const path = join(rolesDir(), `${normalized}.md`)
  if (!existsSync(path)) throw new Error(`角色不存在：${normalized}`)
  return path
}

function writeRole(name, content) {
  writeTextAtomic(roleFileOf(name), content)
  return readRolesDetails()
}

function createRole(name, content = '') {
  const path = join(rolesDir(), `${normalizeRoleName(name)}.md`)
  mkdirSync(rolesDir(), { recursive: true })
  writeFileSync(path, content, { encoding: 'utf-8', flag: 'wx' })
  return readRolesDetails()
}

function deleteRole(name) {
  rmSync(roleFileOf(name), { force: true })
  return readRolesDetails()
}

/** 会话视图要用「这个会话当时用的角色提示词」把 history 还原成对话 */
function rolePromptOf(name) {
  if (!name || name === 'default') return builtInRolePrompt()
  try {
    return readRoleFile(name) ?? ''
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------- 技能 */

function parseSkillFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const fields = {}
  for (const line of match?.[1]?.split(/\r?\n/) ?? []) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    fields[key] = line
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
  }
  return fields
}

function listSkills() {
  const root = skillsRoot()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .filter((baseDir) => existsSync(join(baseDir, 'SKILL.md')))
    .sort()
    .map((baseDir) => {
      const content = readFileSync(join(baseDir, 'SKILL.md'), 'utf-8')
      const fields = parseSkillFrontmatter(content)
      return {
        name: fields.name || basename(baseDir),
        description: fields.description ?? '',
        whenToUse: fields.whenToUse,
        argumentHint: fields.argumentHint,
        baseDir,
        content,
        editable: true
      }
    })
}

const readSkillsDetails = () => ({ root: skillsRoot(), skills: listSkills() })

function skillDirOf(name) {
  const normalized = String(name ?? '').trim()
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(normalized)) throw new Error('技能名不合法')
  const baseDir = join(skillsRoot(), normalized)
  if (!existsSync(join(baseDir, 'SKILL.md'))) throw new Error(`技能不存在：${normalized}`)
  return baseDir
}

function writeSkill(name, content) {
  writeTextAtomic(join(skillDirOf(name), 'SKILL.md'), content)
  return readSkillsDetails()
}

function createSkill(name, content = '') {
  const normalized = String(name ?? '').trim()
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]*$/u.test(normalized)) throw new Error('技能名不合法')
  const baseDir = join(skillsRoot(), normalized)
  if (existsSync(baseDir)) throw new Error(`技能已存在：${normalized}`)
  mkdirSync(baseDir, { recursive: true })
  writeTextAtomic(
    join(baseDir, 'SKILL.md'),
    content.trim() ||
      `---\nname: ${normalized}\ndescription: ${normalized}\n---\n\n# ${normalized}\n\nDescribe how to use this skill.\n`
  )
  return readSkillsDetails()
}

function deleteSkill(name) {
  rmSync(skillDirOf(name), { recursive: true, force: true })
  return readSkillsDetails()
}

/* ------------------------------------------------------------------ 插件 */

function readPluginStatusByFile() {
  const path = pluginStatusPath()
  if (!existsSync(path)) return new Map()
  try {
    const parsed = readJson(path)
    const entries = [...(parsed.plugins ?? []), ...(parsed.loadFailed ?? [])]
    return new Map(
      entries
        .filter((item) => typeof item?.file === 'string')
        .map((item) => [
          item.file,
          { status: normalizePluginStatus(item.status), error: item.error }
        ])
    )
  } catch {
    return new Map()
  }
}

function normalizePluginStatus(value) {
  return value === 'loaded' || value === 'registered' || value === 'failed' ? value : 'unknown'
}

function readPluginsDetails() {
  const root = pluginsRoot()
  const statusByFile = readPluginStatusByFile()
  const plugins = existsSync(root)
    ? readdirSync(root)
        .filter((name) => name.endsWith('.js') || name.endsWith('.mjs'))
        .sort()
        .map((fileName) => {
          const file = join(root, fileName)
          const stat = statSync(file)
          const name = basename(fileName, extname(fileName))
          return {
            name,
            id: `file.${name}`,
            file,
            content: readFileSync(file, 'utf-8'),
            extension: extname(fileName),
            sizeBytes: stat.size,
            updatedAt: stat.mtime.toISOString(),
            status: statusByFile.get(file)?.status ?? 'unknown',
            error: statusByFile.get(file)?.error
          }
        })
    : []
  return { root, plugins }
}

/* ------------------------------------------------------------------ 会话 */

function sessionPath(id) {
  return join(sessionsDir(), `${id}.json`)
}

function loadSession(id) {
  const safeId = String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '')
  const path = sessionPath(safeId)
  if (!safeId || !existsSync(path)) throw new Error(`会话不存在：${id}`)
  return { session: readJson(path), path }
}

function readSessionTitle(path) {
  const head = readFileSync(path, 'utf-8').slice(0, 4096)
  const match = head.match(/"title"\s*:\s*("(?:\\.|[^"\\])*")/)
  return match ? JSON.parse(match[1]) : undefined
}

function listRecentSessions() {
  const directory = sessionsDir()
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .flatMap((entry) => {
      const path = join(directory, entry.name)
      const id = basename(entry.name, '.json')
      try {
        return [
          { id, title: readSessionTitle(path) ?? id, updatedAt: statSync(path).mtime.toISOString() }
        ]
      } catch {
        return []
      }
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

const readSessionsDetails = () => ({ root: sessionsDir(), sessions: listRecentSessions() })

const sessionUsage = (session) => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  turnState: session.turnState,
  providerId: session.snapshot.providerId,
  model: session.snapshot.model,
  role: session.snapshot.role
})

function readSessionDetails(id) {
  const { session, path } = loadSession(id)
  const lastUsage = session.snapshot.lastUsage
  return {
    ...sessionUsage(session),
    cwd: session.cwd,
    fileSizeBytes: statSync(path).size,
    messageCount: session.snapshot.messages.length,
    usageCount: session.snapshot.usageHistory.length,
    contextWindowSize: session.snapshot.contextWindowSize,
    lastUsage: lastUsage
      ? {
          inputTokens: lastUsage.inputTokens,
          cachedInputTokens: lastUsage.cachedInputTokens,
          outputTokens: lastUsage.outputTokens,
          totalTokens: lastUsage.totalTokens
        }
      : undefined
  }
}

const readSessionContent = (id) => ({ content: JSON.stringify(loadSession(id).session, null, 2) })

function writeSession(id, content) {
  const parsed = JSON.parse(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('会话内容必须是 JSON 对象')
  }
  const safeId = String(id ?? '').replace(/[^A-Za-z0-9._-]/g, '')
  if (!safeId || !existsSync(sessionPath(safeId))) throw new Error(`会话不存在：${id}`)
  writeTextAtomic(sessionPath(safeId), `${JSON.stringify(parsed, null, 2)}\n`)
  return readSessionDetails(safeId)
}

function conversationSource(session) {
  return {
    providerId: session.snapshot.providerId,
    protocol: session.snapshot.protocol,
    model: session.snapshot.model,
    systemPrompt: rolePromptOf(session.snapshot.role),
    messages: session.snapshot.messages
  }
}

function conversationItems(id) {
  const { session } = loadSession(id)
  return buildConfigWebConversationItems(conversationSource(session))
}

function readSessionConversationPage(id, offset, limit, tail = false) {
  const items = conversationItems(id)
  const total = items.length
  const start = tail
    ? Math.max(0, total - limit)
    : Math.min(Math.max(0, offset), Math.max(0, total - 1))
  const end = Math.min(total, start + Math.max(1, Math.min(500, limit)))
  return { id, total, offset: start, limit: end - start, items: items.slice(start, end) }
}

function readSessionItem(id, sequence) {
  const items = conversationItems(id)
  const index = Math.min(Math.max(1, sequence), items.length) - 1
  if (!items[index]) throw new Error(`会话条目不存在：sequence ${sequence}`)
  return items[index]
}

function readSessionContextAnalysis(id) {
  const { session } = loadSession(id)
  return buildConfigWebContextAnalysis(
    conversationSource(session),
    session.snapshot.usageHistory,
    session.snapshot.contextWindowSize
  )
}

/* -------------------------------------------------------------- 自动压缩 */

/**
 * 计数按 sessionId 记（真正的数据与规则在 host/auto-compact.js，这里只是给页面看的投影）。
 * 标题从会话文件里现读：计数可以留着已经删掉的会话，那就只显示 id 片段而不是当成错误。
 */
function sessionTitleOf(sessionId) {
  const safeId = String(sessionId ?? '').replace(/[^A-Za-z0-9._-]/g, '')
  if (!safeId) return undefined
  const path = sessionPath(safeId)
  if (!existsSync(path)) return undefined
  try {
    return readSessionTitle(path)
  } catch {
    return undefined
  }
}

/** 最近压过的排前面；没压成功过（没有时间戳）的排最后，顺序稳定。 */
function autoCompactCounters(counters) {
  return Object.entries(counters)
    .map(([sessionId, countersOfSession]) => ({
      sessionId,
      title: sessionTitleOf(sessionId),
      ...countersOfSession
    }))
    .sort((left, right) => {
      const leftAt = Date.parse(left.lastRunAt || '')
      const rightAt = Date.parse(right.lastRunAt || '')
      return (Number.isFinite(rightAt) ? rightAt : -1) - (Number.isFinite(leftAt) ? leftAt : -1)
    })
}

function readAutoCompactDetails() {
  const snapshot = getAutoCompactSnapshot()
  return {
    path: snapshot.path,
    settings: snapshot.settings,
    defaults: { ...DEFAULT_AUTO_COMPACT_SETTINGS },
    counters: autoCompactCounters(snapshot.counters)
  }
}

/* ------------------------------------------------------------ 受控浏览器 */

/**
 * 配置页只看这台机器上的运行时：窗口命令与「读详情」都直接委托给 host/browser-control.js，
 * 那是这条能力的唯一实现（它自己走主进程的 Unix socket，并在没有服务时交回
 * `available: false` 的详情而不是抛错）。这里刻意不再自己拼一遍请求——两个入口各写一份
 * 容错口径，迟早会在超时或错误文案上分叉。
 */
async function runBrowserCommand(command, input) {
  try {
    await command(input)
  } catch (error) {
    // 配置页的语义是「看当前状态」而不是「执行成功」：命令失败也要把页面刷成最新的
    // 详情（含 error 字段），让用户看到为什么没成，而不是收到一个抛错的弹窗。
    console.error('[mica-desktop] 受控浏览器命令失败:', error)
  }
  return readBrowserControlDetailsFromHost()
}

async function createBrowserControlWindow(input = {}) {
  return runBrowserCommand(createBrowserWindow, input)
}

async function closeBrowserControlWindow(input = {}) {
  return runBrowserCommand(closeBrowserWindow, input)
}

async function showBrowserControlWindow(input = {}) {
  return runBrowserCommand(showBrowserWindow, input)
}

async function hideBrowserControlWindow(input = {}) {
  return runBrowserCommand(hideBrowserWindow, input)
}

/* ------------------------------------------------------------------ 动作表 */

function addMcpServer(name, content) {
  const normalized = normalizeMcpName(name)
  updateMcpServers((servers) => {
    if (normalized in servers) throw new Error(`MCP server 已存在：${normalized}`)
    servers[normalized] = parseMcpServerConfig(
      String(content ?? '').trim() ||
        JSON.stringify(
          { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
          null,
          2
        ),
      normalized
    )
  })
  return readMcpDetails()
}

function saveMcpServer(name, content) {
  const normalized = normalizeMcpName(name)
  updateMcpServers((servers) => {
    if (!(normalized in servers)) throw new Error(`MCP server 不存在：${normalized}`)
    servers[normalized] = parseMcpServerConfig(content, normalized)
  })
  return readMcpDetails()
}

function removeMcpServer(name) {
  const normalized = normalizeMcpName(name)
  updateMcpServers((servers) => {
    if (!(normalized in servers)) throw new Error(`MCP server 不存在：${normalized}`)
    delete servers[normalized]
  })
  return readMcpDetails()
}

/**
 * 配置页的数据动作：入参是一个具名参数对象，与 packages/mica-config-ui 的
 * ConfigWebClient 一一对应（见 apps/desktop/src/renderer/src/config-web.js）。
 */
export const configWebActions = {
  readConfigFile: () => readConfigFile(),
  writeConfigFile: (input) => writeConfigFile(text(input, 'content')),

  readMcpDetails: () => readMcpDetails(),
  createMcpServer: (input) => addMcpServer(text(input, 'name'), optionalText(input, 'content')),
  writeMcpServer: (input) => saveMcpServer(text(input, 'name'), text(input, 'content')),
  deleteMcpServer: (input) => removeMcpServer(text(input, 'name')),

  readRolesDetails: () => readRolesDetails(),
  createRole: (input) => createRole(text(input, 'name'), optionalText(input, 'content')),
  writeRole: (input) => writeRole(text(input, 'name'), text(input, 'content')),
  deleteRole: (input) => deleteRole(text(input, 'name')),

  readSkillsDetails: () => readSkillsDetails(),
  createSkill: (input) => createSkill(text(input, 'name'), optionalText(input, 'content')),
  writeSkill: (input) => writeSkill(text(input, 'name'), text(input, 'content')),
  deleteSkill: (input) => deleteSkill(text(input, 'name')),

  readPluginsDetails: () => readPluginsDetails(),

  readSessionsDetails: () => readSessionsDetails(),
  readSessionDetails: (input) => readSessionDetails(text(input, 'id')),
  readSessionContent: (input) => readSessionContent(text(input, 'id')),

  readAutoCompactDetails: () => readAutoCompactDetails(),
  writeAutoCompactSettings: (input) => {
    saveAutoCompactSettings(input?.settings)
    return readAutoCompactDetails()
  },
  resetAutoCompactCounters: (input) => {
    resetAutoCompactCountersInStore(input?.sessionId)
    return readAutoCompactDetails()
  },

  readBrowserControlDetails: () => readBrowserControlDetailsFromHost(),
  createBrowserControlWindow: (input) => createBrowserControlWindow(input),
  closeBrowserControlWindow: (input) => closeBrowserControlWindow(input),
  showBrowserControlWindow: (input) => showBrowserControlWindow(input),
  hideBrowserControlWindow: (input) => hideBrowserControlWindow(input),

  readSessionConversationPage: (input) =>
    readSessionConversationPage(
      text(input, 'id'),
      integer(input, 'offset', 0),
      integer(input, 'limit', 80),
      input.tail === true
    ),
  readSessionItem: (input) => readSessionItem(text(input, 'id'), integer(input, 'sequence', 1)),
  readSessionContextAnalysis: (input) => readSessionContextAnalysis(text(input, 'id')),
  writeSession: (input) => writeSession(text(input, 'id'), text(input, 'content'))
}

export function isConfigWebAction(action) {
  return typeof action === 'string' && Object.hasOwn(configWebActions, action)
}

export function runConfigWebAction(action, input = {}) {
  const handler = configWebActions[action]
  if (!handler) throw new Error(`未知的配置操作：${action}`)
  return handler(input ?? {})
}

function text(input, field) {
  const value = input?.[field]
  if (typeof value !== 'string') throw new Error(`${field} 必须是字符串`)
  return value
}

function optionalText(input, field) {
  const value = input?.[field]
  if (value === undefined) return ''
  return text(input, field)
}

function integer(input, field, fallback) {
  const value = Number(input?.[field])
  return Number.isInteger(value) && value >= 0 ? value : fallback
}
