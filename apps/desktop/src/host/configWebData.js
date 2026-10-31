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
import { countUsageRequests } from '@packages/mica-web-shared/usage-source.js'
import {
  buildConfigWebConversationItems,
  buildConfigWebContextAnalysis
} from '@mica-config-ui/session-view'
import {
  getCapabilityDefaultsDetails,
  writeCapabilityDefaults
} from '@mica-config-ui/capability-defaults'
// 插件列表要同时认识官方插件（清单编译进产物）和用户插件（磁盘上的目录），因此和
// config-web 共用同一份实现，不再在这里抄一遍扫描逻辑。
import {
  getPluginsDetails,
  setPluginEnabled as setPluginEnabledInStore,
  setPluginSettings as setPluginSettingsInStore,
  testPluginLlm as testPluginLlmInStore
} from '@mica-config-ui/plugins'
import { runPluginAction as runPluginActionProcess } from '@mica-config-ui/plugin-action'
import { summarizeSessionFile } from '@mica-config-ui/session-head'
// 内置 default role 与 CLI 同源：提示词模板就是 packages/mica-agent/prompt/system.md，
// 展开品牌占位符后原样展示（只读），桌面宿主不自己留一份副本。
import defaultSystemPromptTemplate from '@packages/mica-agent/prompt/system.md?raw'
import { applyBrandTemplate } from '@packages/mica-agent/prompt/brandTemplate.js'
import { readBrowserControlDetails as readBrowserControlDetailsFromHost } from './browser-control.js'
import { readTerminalControlDetails as readTerminalControlDetailsFromHost } from './terminal-control.js'
import { openSystemSettings, readSystemChecks } from './system-checks.js'
import { probeMcpServers } from './mcp-probe.js'
import { clearLogs, readPerformanceSummary } from './log.js'

/**
 * 配置页在桌面运行时的数据层。
 *
 * 直接读写本机的 `$MICA_HOME`（config.json / role / skills / plugins / sessions），不依赖
 * CLI 的那些运行时包 —— 页面组件来自 packages/mica-config-ui，但它引用的数据操作在这里
 * 用最朴素的文件读写实现，和 CLI 侧（apps/config-web 的 server.ts）各自对着一份数据。
 *
 * 受控浏览器的窗口活在 Electron 主进程（host/browser-control.js），运行时是纯 Node，
 * 两边只能靠本机 HTTP 服务通信 —— 这里转发「读详情」，窗口的开 / 显示 / 隐藏 / 关闭
 * 全归 agent 经那套接口（与主区顶栏图标）做，配置页不提供入口。
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

/**
 * MCP 列表。
 *
 * 连接本身发生在会话子进程里，宿主不持有连接，所以状态靠自己探一次（`mcp-probe.js`）：
 * http 类型的 server 能当场问出「能不能用 + 有几个工具」，stdio 的起进程代价太大，只报
 * 「已配置」并由页面说明连接时机。
 */
async function readMcpDetails() {
  const configured = existsSync(configPath()) ? (readJson(configPath()).mcpServers ?? {}) : {}
  const probes = await probeMcpServers(configured)
  return {
    path: configPath(),
    servers: Object.entries(configured).map(([name, config]) => ({
      ...describeMcpConfig(name, config),
      ...(probes.get(name) ?? { status: 'configured', toolCount: 0, tools: [] })
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

/**
 * 老会话的标题可能从带图片的输入原样截出来（`[Image](/Users/…/a.png) 帮我看下`）。
 * 本地路径对列表毫无意义，读取时剥掉占位符即可，不必改写用户文件。
 */
function cleanSessionTitle(title) {
  const stripped = String(title ?? '')
    .replace(/\[Image\]\([^)]*\)|\[图片\]|\[Image\]|\[image omitted[^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped || String(title ?? '')
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
        const summary = summarizeSessionFile(path, id)
        return [{ ...summary, title: cleanSessionTitle(summary.title) }]
      } catch {
        return []
      }
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

const readSessionsDetails = () => ({ root: sessionsDir(), sessions: listRecentSessions() })

const sessionUsage = (session) => ({
  id: session.id,
  title: cleanSessionTitle(session.title),
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
    // 同一个口径：主对话 + 委派 + 插件 + 内核后台的请求数（见 usage-source）。
    usageCount: countUsageRequests(session.snapshot),
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
    // 会话快照里存着最近一次请求真正发出的完整提示词；旧会话没有记录，退回角色文件里那一段
    // （只含 <system>，不含 skills 索引 / AGENT.md / 插件段落）。
    systemPrompt: session.snapshot.systemPrompt || rolePromptOf(session.snapshot.role),
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
  return buildConfigWebContextAnalysis(conversationSource(session), {
    usageHistory: session.snapshot.usageHistory,
    contextWindowSize: session.snapshot.contextWindowSize,
    lastUsage: session.snapshot.lastUsage,
    displayUsage: session.snapshot.displayUsage
  })
}

function readSessionSystemPrompt(id) {
  const { session } = loadSession(id)
  return {
    prompt: typeof session.snapshot.systemPrompt === 'string' ? session.snapshot.systemPrompt : '',
    rolePrompt: rolePromptOf(session.snapshot.role)
  }
}

/* ------------------------------------------------------------ 受控浏览器 */

/* ------------------------------------------------------------------ 动作表 */

async function addMcpServer(name, content) {
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

async function saveMcpServer(name, content) {
  const normalized = normalizeMcpName(name)
  updateMcpServers((servers) => {
    if (!(normalized in servers)) throw new Error(`MCP server 不存在：${normalized}`)
    servers[normalized] = parseMcpServerConfig(content, normalized)
  })
  return readMcpDetails()
}

async function removeMcpServer(name) {
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

  readCapabilityDefaults: () => getCapabilityDefaultsDetails(),
  writeCapabilityDefaults: (input) =>
    writeCapabilityDefaults({
      disabledSkills: input?.disabledSkills,
      disabledTools: input?.disabledTools,
      disabledMcpServers: input?.disabledMcpServers
    }),

  readPluginsDetails: () => getPluginsDetails(),
  setPluginEnabled: (input) => setPluginEnabledInStore(text(input, 'id'), input?.enabled === true),
  writePluginSettings: (input) =>
    setPluginSettingsInStore(text(input, 'id'), isRecord(input?.values) ? input.values : {}),
  // 试连插件声明的模型接口：与插件运行时同一条请求实现，测通了就代表它能工作。
  testPluginLlm: (input) =>
    testPluginLlmInStore(text(input, 'id'), isRecord(input?.values) ? input.values : undefined),
  // 清单声明的配置页动作（注册这类）：由一次性的 `mica plugin-action` 执行，
  // 页面不用为此跳到对话里，也不再需要会话宿主在线。
  runPluginAction: (input) =>
    runPluginActionProcess({
      id: text(input, 'id'),
      action: text(input, 'action'),
      values: isRecord(input?.values) ? input.values : undefined
    }),

  // 插件声明了运行条件（清单 desktop.checks）时，插件详情页据此显示「开了没有 / 去哪开」。
  // 探测在 Electron 主进程（TCC 权限属于有 app 身份的那个进程），见 system-checks.js。
  readDesktopChecks: () => readSystemChecks(),
  openDesktopSettings: (input) => openSystemSettings(text(input, 'pane')),

  readSessionsDetails: () => readSessionsDetails(),
  readSessionDetails: (input) => readSessionDetails(text(input, 'id')),
  readSessionContent: (input) => readSessionContent(text(input, 'id')),

  readBrowserControlDetails: () => readBrowserControlDetailsFromHost(),
  readTerminalControlDetails: () => readTerminalControlDetailsFromHost(),

  // 性能与诊断：读的是 host/log.js 写在日志目录下的 JSONL，聚合在 host 侧做完。
  readPerformanceDetails: (input) => readPerformanceSummary(input ?? {}),
  clearPerformanceLogs: () => clearLogs(),

  readSessionConversationPage: (input) =>
    readSessionConversationPage(
      text(input, 'id'),
      integer(input, 'offset', 0),
      integer(input, 'limit', 80),
      input.tail === true
    ),
  readSessionItem: (input) => readSessionItem(text(input, 'id'), integer(input, 'sequence', 1)),
  readSessionContextAnalysis: (input) => readSessionContextAnalysis(text(input, 'id')),
  readSessionSystemPrompt: (input) => readSessionSystemPrompt(text(input, 'id')),
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

/** 插件设置是一张键值表；不是对象就当空表，别把半截数据写进设置文件。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integer(input, field, fallback) {
  const value = Number(input?.[field])
  return Number.isInteger(value) && value >= 0 ? value : fallback
}
