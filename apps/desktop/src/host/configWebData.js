import { isRecord } from '@packages/mica-common/guards.js'
import { comparableText } from '@packages/mica-common/promptText.js'
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
import { basename, dirname, extname, join } from 'node:path'
import { resolveMicaHomePath } from '@packages/mica-config/brand.js'
import {
  buildSessionHeader,
  conversationItemAt,
  sessionContextAnalysis,
  sessionConversationItems,
  sliceConversationPage
} from '@packages/mica-config-ui/src/server/sessionView.ts'
import {
  getCapabilityDefaultsDetails,
  writeCapabilityDefaults
} from '@packages/mica-config-ui/src/server/capabilityDefaults.ts'
// 插件列表要同时认识官方插件（清单编译进产物）和用户插件（磁盘上的目录），因此和
// config-web 共用同一份实现，不再在这里抄一遍扫描逻辑。
import {
  getPluginsDetails,
  setPluginEnabled as setPluginEnabledInStore,
  setPluginSettings as setPluginSettingsInStore,
  testPluginLlm as testPluginLlmInStore
} from '@packages/mica-config-ui/src/server/plugins.ts'
import { testProviderConnection } from '@packages/mica-config-ui/src/server/providerTest.ts'
import { runPluginAction as runPluginActionProcess } from '@packages/mica-config-ui/src/server/pluginAction.ts'
import { listConfigWebSessions } from '@packages/mica-config-ui/src/server/sessionHead.ts'
// 内置 default role 与 CLI 同源：提示词模板就是 packages/mica-agent/prompt/system.md，
// 展开品牌占位符后原样展示（只读），桌面宿主不自己留一份副本。
import defaultSystemPromptTemplate from '@packages/mica-agent/prompt/system.md' with { type: 'text' }
import { applyBrandTemplate } from '@packages/mica-agent/prompt/brandTemplate.js'
import { wrapPromptXml } from '@packages/mica-common/promptXml.js'
import { readPromptControls, writePromptControls } from '@packages/mica-config/promptControls.js'
import { readBrowserControlDetails as readBrowserControlDetailsFromHost } from './browser-control.js'
import { readTerminalControlDetails as readTerminalControlDetailsFromHost } from './terminal-control.js'
import {
  openSystemSettings,
  pickDirectoryNative,
  readSystemChecks,
  requestSystemAccess,
  takeHeapSnapshot
} from './system-checks.js'
import { probeMcpServers } from './mcp-probe.js'
import { clearLogs, readPerformanceSummaryAsync } from './log.js'

/** 桌面设置读当前运行时的文件，复用共享会话投影。系统检查与窗口详情由原生宿主提供。 */
const configPath = () => resolveMicaHomePath('config.json')
const sessionsDir = () => resolveMicaHomePath('sessions')
const rolesDir = () => resolveMicaHomePath('role')
const skillsRoot = () => resolveMicaHomePath('skills')

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
function replaceMcpServers(servers) {
  const path = configPath()
  const current = existsSync(path) ? readJson(path) : {}
  if (!isRecord(current)) throw new Error('config.json 不是 JSON 对象')
  writeTextAtomic(path, `${JSON.stringify({ ...current, mcpServers: servers }, null, 2)}\n`)
}

const normalizeMcpName = (name) => {
  const trimmed = String(name ?? '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trimmed)) {
    throw new Error('MCP 名称只允许字母、数字、下划线和连字符')
  }
  return trimmed
}

function validateMcpServer(config, name) {
  if (!isRecord(config)) throw new Error(`MCP server ${name} 的配置必须是 JSON 对象`)
  if (typeof config.url !== 'string' && typeof config.command !== 'string') {
    throw new Error(`MCP server ${name} 需要 url 或 command`)
  }
  return config
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
    // 卡片与 JSON 视图按文件原文重建：读进来的那份已经展开过 ${VAR}，写回去会把占位符换成端口。
    content: `${JSON.stringify(configured, null, 2)}\n`,
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
      envKeys: config.headers ? Object.keys(config.headers) : []
    }
  }
  return {
    name,
    type: 'stdio',
    target: `${config.command} ${(config.args ?? []).join(' ')}`.trim(),
    configPath: configPath(),
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
            !/^default(?:\.md)*$/i.test(basename(entry.name, extname(entry.name)).trim())
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
  if (/^default(?:\.md)*$/i.test(trimmed)) throw new Error('默认系统提示词只读')
  return trimmed
}

function roleFileOf(name) {
  const normalized = normalizeRoleName(name)
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

/** 旧会话仅展示当前默认正文与 Role 的参考，不冒充历史存档。 */
function rolePromptOf(name) {
  const base = wrapPromptXml('system', builtInRolePrompt())
  if (!name || name === 'default') return base
  try {
    const role = readRoleFile(normalizeRoleName(name))
    return role?.trim() ? `${base}\n\n${wrapPromptXml('role', applyBrandTemplate(role))}` : base
  } catch {
    return base
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

function cleanSessionTitle(title) {
  return comparableText(title) || String(title ?? '')
}

function readSessionDetails(id) {
  const { session, path } = loadSession(id)
  return buildSessionHeader(session, statSync(path).size, cleanSessionTitle(session.title))
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

function conversationItems(id) {
  return sessionConversationItems(loadSession(id).session.snapshot, rolePromptOf)
}

function readSessionItem(id, sequence) {
  const item = conversationItemAt(conversationItems(id), sequence)
  if (!item) throw new Error(`会话条目不存在：sequence ${sequence}`)
  return item
}

function readSessionSystemPrompt(id) {
  const { session } = loadSession(id)
  return {
    prompt: typeof session.snapshot.systemPrompt === 'string' ? session.snapshot.systemPrompt : '',
    rolePrompt: rolePromptOf(session.snapshot.role)
  }
}

/* ------------------------------------------------------------------ 动作表 */

/** 整份 mcpServers 一起写：卡片的改名、增删都落成同一份内容。 */
async function saveMcpServers(content) {
  let parsed
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('mcpServers 不是有效的 JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('mcpServers 必须是「名称 → 配置」的 JSON 对象')
  }
  const servers = {}
  for (const [name, config] of Object.entries(parsed)) {
    const normalized = normalizeMcpName(name)
    if (normalized in servers) throw new Error(`MCP server 重名：${normalized}`)
    servers[normalized] = validateMcpServer(config, normalized)
  }
  replaceMcpServers(servers)
  return readMcpDetails()
}

/**
 * 配置页的数据动作：入参是一个具名参数对象，与 packages/mica-config-ui 的
 * ConfigWebClient 一一对应（见 apps/desktop/src/renderer/src/config-web.js）。
 */
export const configWebActions = {
  readConfigFile: () => readConfigFile(),
  writeConfigFile: (input) => writeConfigFile(text(input, 'content')),
  // 服务商试连：与插件试连同一条执行器，页面上改完不用先保存再测。
  testProvider: (input) =>
    testProviderConnection({
      apiBase: text(input, 'apiBase'),
      apiKey: optionalText(input, 'apiKey'),
      protocol: optionalText(input, 'protocol'),
      model: text(input, 'model')
    }),

  readMcpDetails: () => readMcpDetails(),
  writeMcpServers: (input) => saveMcpServers(text(input, 'content')),

  readRolesDetails: () => readRolesDetails(),
  createRole: (input) => createRole(text(input, 'name'), optionalText(input, 'content')),
  writeRole: (input) => writeRole(text(input, 'name'), text(input, 'content')),
  deleteRole: (input) => deleteRole(text(input, 'name')),

  readSkillsDetails: () => readSkillsDetails(),
  createSkill: (input) => createSkill(text(input, 'name'), optionalText(input, 'content')),
  writeSkill: (input) => writeSkill(text(input, 'name'), text(input, 'content')),
  deleteSkill: (input) => deleteSkill(text(input, 'name')),

  readCapabilityDefaults: () => getCapabilityDefaultsDetails(),
  readPromptControls: () => readPromptControls(),
  writePromptControls: (input) => writePromptControls(input?.controls),
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
      cwd: typeof input?.cwd === 'string' && input.cwd ? input.cwd : undefined,
      values: isRecord(input?.values) ? input.values : undefined
    }),

  // 插件声明了运行条件（清单 desktop.checks）时，插件详情页据此显示「开了没有 / 去哪开」。
  // 探测在 Electron 主进程（TCC 权限属于有 app 身份的那个进程），见 system-checks.js。
  readDesktopChecks: () => readSystemChecks(),
  openDesktopSettings: (input) => openSystemSettings(text(input, 'pane')),
  // 「请求授权」：让系统就地把**这次运行的构建**登记进辅助功能列表。只「打开设置」时，
  // 用户很可能去勾上次打包留下的旧条目，勾了也不生效。
  requestDesktopAccess: (input) => requestSystemAccess(text(input, 'id')),
  // 系统的文件夹选择器：插件设置里的「选择文件夹…」用它挑目录。取消照原样回 canceled。
  pickDirectory: (input) =>
    pickDirectoryNative({ title: optionalText(input, 'title'), defaultPath: optionalText(input, 'defaultPath') }),

  readSessionsDetails: () => listConfigWebSessions(sessionsDir(), cleanSessionTitle),
  readSessionDetails: (input) => readSessionDetails(text(input, 'id')),
  readSessionContent: (input) => readSessionContent(text(input, 'id')),

  readBrowserControlDetails: () => readBrowserControlDetailsFromHost(),
  readTerminalControlDetails: () => readTerminalControlDetailsFromHost(),

  // 性能与诊断：读的是 host/log.js 写在日志目录下的 JSONL，聚合在 host 侧做完。
  readPerformanceDetails: (input) => readPerformanceSummaryAsync(input ?? {}),
  clearPerformanceLogs: () => clearLogs(),
  // 渲染层的内存只有主进程拍得到（`webContents.takeHeapSnapshot`），结果落在日志目录。
  takeHeapSnapshot: (input) => takeHeapSnapshot({ windowId: input?.windowId }),

  readSessionConversationPage: (input) => {
    const id = text(input, 'id')
    return sliceConversationPage(
      id,
      conversationItems(id),
      integer(input, 'offset', 0),
      integer(input, 'limit', 80),
      input.tail === true
    )
  },
  readSessionItem: (input) => readSessionItem(text(input, 'id'), integer(input, 'sequence', 1)),
  readSessionContextAnalysis: (input) =>
    sessionContextAnalysis(loadSession(text(input, 'id')).session.snapshot, rolePromptOf),
  readSessionSystemPrompt: (input) => readSessionSystemPrompt(text(input, 'id')),
  writeSession: (input) => writeSession(text(input, 'id'), text(input, 'content'))
}

export function isConfigWebAction(action) {
  return typeof action === 'string' && Object.hasOwn(configWebActions, action)
}

export function runConfigWebAction(action, input) {
  if (!isConfigWebAction(action)) throw new Error(`未知的配置操作：${String(action)}`)
  return configWebActions[action](input ?? {})
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
