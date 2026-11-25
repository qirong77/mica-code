import type { Tool, ToolResult } from './types.js';
import type { Disposable } from '@packages/mica-common/index.js';

import { ToolReadFile } from './ToolReadFile.js';
import { ToolWriteFile } from './ToolWriteFile.js';
import { ToolApplyPatch } from './ToolApplyPatch.js';
import { ToolListFiles } from './ToolListFiles.js';
import { ToolGrepSearch } from './ToolGrepSearch.js';
import { ToolWebFetch } from './ToolWebFetch.js';
import { ToolSkill } from './ToolSkill.js';
import { MicaTool } from './MicaTool.js';
import { toMicaTool } from './PluginTool.js';
import type { PluginToolDescriptor } from './PluginTool.js';
import { ToolRunShell } from './ToolRunShell.js';
import { ToolBackgroundStart } from './ToolBackgroundStart.js';
import { ToolBackgroundTasks } from './ToolBackgroundTasks.js';
import { ToolBackgroundRead } from './ToolBackgroundRead.js';
import { ToolKillTask } from './ToolKillTask.js';
import { ToolReadImage } from './ToolReadImage.js';
import { ToolWaitFor } from './ToolWaitFor.js';
import type { ToolExecuteCallbacks, ToolInput, ToolSource } from './MicaTool.js';
import { RUNTIME_TOOL_DESCRIPTORS } from './runtimeToolDescriptors.js';
import {
  writeToolCatalogProjection,
  type ToolCatalogProjectionEntry,
} from './toolCatalogProjection.js';
import { toolIcon } from '@packages/mica-common/toolIcons.js';
import type { ToolIconCatalog } from './toolIconCatalog.js';
import { writeToolIconCatalog } from './toolIconCatalog.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';

export type ToolFilter = (name: string) => boolean;

export type RuntimeToolRegistrationOptions = {
  primaryAgentOnly?: boolean;
  group?: ToolGroupEntry;
  /**
   * 工具行左侧的 emoji（`ctx.tools.register(tool, { icon })`）。
   *
   * 内置工具在自己的类里写死 `icon`；插件工具只有这一处能声明，声明完就跟着工具实例
   * 走——终端直接读注册表，桌面读的是这份注册表的投影（见 `toolIconCatalog.ts`）。
   */
  icon?: string;
};

export type ToolCatalogEntry = {
  name: string;
  description: string;
  /** 注册工具发送给模型的完整入参结构；静态目录占位项可能没有。 */
  inputSchema?: MicaTool['input_schema'];
  source: ToolSource;
  /** Original MCP server name for `source: 'mcp'` entries. */
  mcpServer?: string;
  readOnly: boolean;
  /** 入参摘要：能力面板的详情要能说清这个工具吃什么，不用去翻代码。 */
  parameters: ToolParameterEntry[];
  /** 所属插件；内核工具可按工具族分组，`null` 表示独立工具。 */
  group: ToolGroupEntry | null;
  /** 工具行左侧的 emoji；没声明的工具是 `DEFAULT_TOOL_ICON`。 */
  icon: string;
};

export type ToolGroupEntry = {
  key: string;
  label: string;
};

export type ToolParameterEntry = {
  name: string;
  type: string;
  required: boolean;
  description: string;
};

/**
 * 工具族的显示名。只有真正同族的工具（共享名字前缀且不止一个成员）才成组，
 * 其余工具一律平铺——它们之间没有共同的调用语义，硬凑成「文件 / 命令」这类类别反而
 * 让人看不出这个组到底改动了什么。新增族时在这里补中文名，缺省用前缀本身。
 */
const TOOL_FAMILY_LABELS: Record<string, string> = {
  session: '会话自治',
  loop: '定时循环',
  background_tasks: '后台任务',
};

/**
 * 配置页 / 桌面设置页兜底用的那份「停用插件」名单。
 *
 * 只为了不给已经关掉的插件补目录行；读不到（没有状态文件、坏文件）当作「一个都没停用」。
 */
function readDisabledPlugins(): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(join(resolveMicaHome(), 'plugins-state.json'), 'utf-8')) as {
      disabled?: unknown;
    };
    const disabled = Array.isArray(parsed?.disabled) ? parsed.disabled : [];
    return new Set(disabled.filter((id) => typeof id === 'string' && id.trim() !== '') as string[]);
  } catch {
    return new Set();
  }
}

export type ToolExecutionEvent = {
  name: string;
  input: ToolInput;
  callbacks?: ToolExecuteCallbacks;
  readOnly: boolean;
};

export type ToolExecutionObserver = {
  before?(event: ToolExecutionEvent): unknown | Promise<unknown>;
  after?(event: ToolExecutionEvent & { result?: ToolResult; error?: unknown; state?: unknown }): void | Promise<void>;
};

const builtinTools: MicaTool[] = [
  new ToolReadFile(),
  new ToolReadImage(),
  new ToolWriteFile(),
  new ToolApplyPatch(),
  new ToolListFiles(),
  new ToolGrepSearch(),
  new ToolRunShell(),
  new ToolBackgroundStart(),
  new ToolBackgroundTasks(),
  new ToolBackgroundRead(),
  new ToolKillTask(),
  new ToolWaitFor(),
  new ToolWebFetch(),
  new ToolSkill(),
];

let mcpTools: MicaTool[] = [];
let runtimeTools: MicaTool[] = [];
/**
 * 是否给「只在会话里注册」的工具补目录行（`RUNTIME_TOOL_DESCRIPTORS`）。
 *
 * 这是给不加载插件的宿主（配置页、桌面设置页）用的兜底。真正跑插件的进程（TUI、
 * `mica app-server`）在装配之后把它关掉：那里注册表就是事实来源，停用一个插件之后
 * 它的工具必须从目录里消失，而不是被一份静态描述重新补回来。
 */
let runtimeToolFallback = true;
const runtimeToolOptions = new WeakMap<MicaTool, RuntimeToolRegistrationOptions>();
const executionObservers = new Set<ToolExecutionObserver>();
/**
 * 投影目录：宿主装配完插件后调 `publishToolIcons()` 一次性打开，此后工具增减都会
 * 自动重写 `tool-icons.json`（同一 tick 内合并成一次）。没打开的宿主（配置页、测试）
 * 一行业务都不做——注册表不背「到处写盘」的责任。
 */
let iconCatalogDir: string | null = null;
let iconCatalogQueued = false;
/**
 * 目录投影目录：与图标投影同一个打开时机（`publishToolCatalog()`），此后工具增减都会
 * 重写 `plugin-tools.json`（同一 tick 内与图标合并成一次）。没有装配过插件的宿主不写。
 */
let catalogProjectionDir: string | null = null;
let catalogProjectionQueued = false;
/** 本进程发布过、需要整组替换的插件：插件停用后它那一组条目要跟着消失。 */
const catalogPublishedPluginIds = new Set<string>();

export function observeToolExecution(observer: ToolExecutionObserver): Disposable {
  executionObservers.add(observer);
  return {
    dispose: () => {
      executionObservers.delete(observer);
    },
  };
}

export function registerMcpTools(tools: MicaTool[]): void {
  mcpTools = tools;
}

export function unregisterMcpTools(): void {
  mcpTools = [];
}

/**
 * 注册一个会话期工具（插件注册走这里）。
 *
 * 收纯描述或 `MicaTool` 实例：用户插件没有仓库模块可导入，只能给描述（见
 * `PluginTool.ts`）。返回真正注册的那个实例，调用方按它反注册——传进来的描述对象
 * 与它并不是同一个东西。
 */
export function registerRuntimeTool(
  tool: MicaTool | PluginToolDescriptor,
  options: RuntimeToolRegistrationOptions = {},
): MicaTool {
  const registered = toMicaTool(tool);
  // 图标只在这里落一次：注册选项优先于工具自己写的声明（插件可以覆盖内置工具的 emoji）。
  if (options.icon) registered.icon = options.icon;
  runtimeTools = [...runtimeTools.filter((entry) => entry !== registered), registered];
  runtimeToolOptions.set(registered, options);
  scheduleIconCatalogSync();
  scheduleCatalogProjectionSync();
  return registered;
}

export function unregisterRuntimeTool(nameOrTool: string | MicaTool): void {
  runtimeTools =
    typeof nameOrTool === 'string'
      ? runtimeTools.filter((tool) => tool.name !== nameOrTool)
      : runtimeTools.filter((tool) => tool !== nameOrTool);
  scheduleIconCatalogSync();
  scheduleCatalogProjectionSync();
}

export function unregisterRuntimeTools(): void {
  runtimeTools = [];
  scheduleIconCatalogSync();
  scheduleCatalogProjectionSync();
}

/** 装配过插件的宿主关掉静态兜底（见 `runtimeToolFallback`）。 */
export function setRuntimeToolFallback(enabled: boolean): void {
  runtimeToolFallback = enabled;
}

/**
 * 工具行图标：工具自己声明的那一个（见 `MicaTool.icon`），没声明就是默认齿轮。
 *
 * 终端（`mica-ui`）直接读这里；桌面渲染层读同一份数据的投影（`publishToolIcons()`）。
 */
export function getToolIcon(name: string): string {
  return toolIcon(name, (candidate) => findTool(candidate)?.icon);
}

/**
 * 当前注册表里所有**声明了 emoji** 的工具：{ 工具名: emoji }。
 *
 * 排除 MCP 工具：它们的图标由 `mcp__` 前缀决定（一个插头），不需要逐条投影，否则每接
 * 一个 server 就往文件里塞几十行会变的键。
 */
export function getToolIcons(): ToolIconCatalog {
  const icons: ToolIconCatalog = {};
  for (const tool of getAllToolsForPrompt()) {
    if (tool.source === 'mcp' || tool.name.startsWith('mcp__')) continue;
    const icon = (tool.icon ?? '').trim();
    if (icon) icons[tool.name] = icon;
  }
  return icons;
}

/**
 * 打开图标投影：装配过插件的宿主调一次，之后注册表自己把变化写进 `tool-icons.json`。
 *
 * 传 `null` 关闭（测试与一次性运行用得上）。桌面渲染层在另一个进程、还要画没启动会话的
 * 历史消息，只能靠这份文件拿到插件工具长什么样。
 */
export function publishToolIcons(configDir: string | null): void {
  iconCatalogDir = configDir;
  if (configDir) scheduleIconCatalogSync();
}

/** 同一 tick 里的多次注册 / 卸载合并成一次写盘。 */
function scheduleIconCatalogSync(): void {
  if (!iconCatalogDir || iconCatalogQueued) return;
  iconCatalogQueued = true;
  queueMicrotask(() => {
    iconCatalogQueued = false;
    if (!iconCatalogDir) return;
    writeToolIconCatalog(getToolIcons(), iconCatalogDir);
  });
}

/**
 * 插件工具的目录投影：`{ 工具名: 描述 / 入参 / 归属插件 }`。
 *
 * 只收带插件归属的工具（`ctx.tools.register()` 时由 PluginManager 注入的 `group`）。
 * 内核工具与 `session_peers` 这类通用运行期工具在配置页有静态目录，不需要跟着这份缓存走。
 */
export function getToolCatalogProjection(): ToolCatalogProjectionEntry[] {
  const entries: ToolCatalogProjectionEntry[] = [];
  for (const tool of runtimeTools) {
    const group = runtimeToolOptions.get(tool)?.group ?? descriptorGroup(tool.name);
    const pluginId = group?.key.startsWith('plugin:') ? group.key.slice('plugin:'.length) : undefined;
    if (!pluginId) continue;
    entries.push({
      name: tool.name,
      description: tool.description,
      readOnly: tool.readOnly,
      parameters: toolParameters(tool),
      group,
      pluginId,
      ...(tool.icon ? { icon: tool.icon } : {}),
    });
  }
  return entries;
}

/**
 * 打开目录投影：装配过插件的常驻宿主（TUI / `mica app-server`）各开一次，此后工具增减
 * 都会重写 `$MICA_HOME/plugin-tools.json`，供不加载插件的配置页 / 桌面设置页补目录行。
 */
export function publishToolCatalog(configDir: string | null): void {
  catalogProjectionDir = configDir;
  if (configDir) scheduleCatalogProjectionSync();
}

/** 同一 tick 里的多次注册 / 卸载合并成一次写盘；写盘按插件合并，不动别的宿主的条目。 */
function scheduleCatalogProjectionSync(): void {
  if (!catalogProjectionDir || catalogProjectionQueued) return;
  catalogProjectionQueued = true;
  queueMicrotask(() => {
    catalogProjectionQueued = false;
    if (!catalogProjectionDir) return;
    const entries = getToolCatalogProjection();
    const current = new Set(entries.map((entry) => entry.pluginId).filter((id): id is string => Boolean(id)));
    const owned = new Set([...catalogPublishedPluginIds, ...current]);
    writeToolCatalogProjection(entries, catalogProjectionDir, { ownedPluginIds: owned });
    catalogPublishedPluginIds.clear();
    for (const id of current) catalogPublishedPluginIds.add(id);
  });
}

function getAllTools(): MicaTool[] {
  return [...builtinTools, ...getActiveRuntimeTools(), ...mcpTools];
}

function getActiveRuntimeTools(): MicaTool[] {
  const active = new Map<string, MicaTool>();
  for (const tool of runtimeTools) {
    active.delete(tool.name);
    active.set(tool.name, tool);
  }
  return [...active.values()];
}

function getAllToolsForPrompt(): MicaTool[] {
  return getAllTools().sort((a, b) => a.name.localeCompare(b.name));
}

function findRegisteredTool(name: string, tools: MicaTool[]): MicaTool | undefined {
  const exact = tools.find((t) => t.name === name);
  if (exact) return exact;
  return tools.find((t) => t.name.endsWith(`__${name}`));
}

function findTool(name: string): MicaTool | undefined {
  return findRegisteredTool(name, getAllTools());
}

/** Registered source lookup for request accounting; never reads the fallback catalog. */
export function getRegisteredToolSource(name: string): { source: ToolSource; mcpServer?: string } | undefined {
  const tool = findRegisteredTool(name, getAllTools());
  return tool ? { source: tool.source, ...(tool.mcpServer ? { mcpServer: tool.mcpServer } : {}) } : undefined;
}

function toolAllowed(tool: MicaTool, requestedName: string, filter?: ToolFilter): boolean {
  return !filter || filter(tool.name) || filter(requestedName);
}

export function getToolDefinitions(filter?: ToolFilter): Tool[] {
  return getAllToolsForPrompt()
    .filter((t) => toolAllowed(t, t.name, filter))
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
}

export function getToolCounts(): { builtin: number; mcp: number; total: number } {
  const builtinCount = builtinTools.length + getActiveRuntimeTools().length;
  return {
    builtin: builtinCount,
    mcp: mcpTools.length,
    total: builtinCount + mcpTools.length,
  };
}

/** Full tool directory (enabled or not) for the capability panel. */
export function getToolCatalog(): ToolCatalogEntry[] {
  const tools = getAllToolsForPrompt();
  const registered = new Set(tools.map((tool) => tool.name));
  const families = toolFamilies([...registered, ...orphanDescriptorNames(registered)]);
  const entries: ToolCatalogEntry[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema,
    source: tool.source === 'mcp' ? 'mcp' : 'builtin',
    mcpServer: tool.mcpServer,
    readOnly: tool.readOnly,
    parameters: toolParameters(tool),
    group: runtimeToolOptions.get(tool)?.group ?? descriptorGroup(tool.name) ?? families.get(tool.name) ?? null,
    icon: toolIcon(tool.name, (name) => findTool(name)?.icon),
  }));
  // 运行期工具只存在于跑 agent 的进程里：配置页 / 桌面设置页不加载插件，目录会缺
  // todo_write 这类工具，「新会话默认值」里就关不掉它们。未注册时用描述补一行。
  // 停用的插件不补：那等于把一个「已经不会注册的工具」留在界面上。
  const disabledPlugins = readDisabledPlugins();
  for (const descriptor of runtimeToolFallback ? RUNTIME_TOOL_DESCRIPTORS : []) {
    if (registered.has(descriptor.name)) continue;
    if (descriptor.pluginId && disabledPlugins.has(descriptor.pluginId)) continue;
    entries.push({
      ...descriptor,
      source: 'builtin',
      group: descriptorGroup(descriptor.name) ?? families.get(descriptor.name) ?? null,
      icon: toolIcon(descriptor.name, (name) => findTool(name)?.icon),
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** 不加载插件的配置宿主从静态目录读取相同归属。 */
function descriptorGroup(name: string): ToolGroupEntry | null {
  const descriptor = RUNTIME_TOOL_DESCRIPTORS.find((entry) => entry.name === name);
  return descriptor?.pluginId ? { key: `plugin:${descriptor.pluginId}`, label: descriptor.pluginId } : null;
}

function orphanDescriptorNames(registered: Set<string>): string[] {
  return RUNTIME_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name).filter((name) => !registered.has(name));
}

/**
 * 识别工具族：前缀在 `TOOL_FAMILY_LABELS` 里声明过、且当前确实有 ≥2 个成员。
 *
 * 不按「前缀相同就算一族」自动推断：`read_file` / `read_image` 前缀相同却分属
 * 不同用途，自动成组后按组开关会连带关掉不相干的能力。所以只认显式
 * 声明的族；其余工具（含 `run_shell`、`apply_patch`、`Agent`）一律独立成行。
 *
 * 成员判定是「等于前缀」或「以前缀加下划线开头」，因此 `background_tasks_start` /
 * `_list` / `_read` / `_kill` 同属一族（启动、查询、读输出、终止是同一件事的四个动作，
 * 整族开关才符合直觉）。前缀本身可以含下划线，长的优先匹配。
 */
function toolFamilies(names: string[]): Map<string, ToolGroupEntry> {
  const families = new Map<string, ToolGroupEntry>();
  const prefixes = Object.keys(TOOL_FAMILY_LABELS).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    const members = names.filter((name) => belongsToFamily(name, prefix));
    if (members.length < 2) continue;
    for (const name of members) {
      if (families.has(name)) continue;
      families.set(name, { key: prefix, label: TOOL_FAMILY_LABELS[prefix] });
    }
  }
  return families;
}

function belongsToFamily(name: string, prefix: string): boolean {
  return name === prefix || name.startsWith(`${prefix}_`);
}

/**
 * 入参的展示用摘要（名称 / 类型 / 是否必填 / 说明）。
 *
 * schema 里没写 `description` 的工具不少，这里不编文案，交给界面显示占位符；
 * 类型取不到时按 `any` 展示，避免出现空白列。
 */
function toolParameters(tool: MicaTool): ToolParameterEntry[] {
  const schema = tool.input_schema ?? {};
  const properties = schema.properties ?? {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(properties).map(([name, property]) => {
    const rawType = property?.type;
    const type = Array.isArray(rawType) ? rawType.join(' | ') : rawType;
    const description = typeof property?.description === 'string' ? property.description : '';
    return {
      name,
      type: type || 'any',
      required: required.has(name),
      description,
    };
  });
}

export async function executeTool(
  name: string,
  input: ToolInput,
  callbacks?: ToolExecuteCallbacks,
  filter?: ToolFilter,
): Promise<ToolResult> {
  const tool = findTool(name);
  if (!tool) return `未知工具: ${name}`;
  if (!toolAllowed(tool, name, filter)) return `工具 ${name} 不在当前 agent 的允许工具范围内。`;

  const validation = tool.validateInput(input);
  if (!validation.valid) {
    return `工具 ${name} 输入校验失败：${validation.message}`;
  }

  const event: ToolExecutionEvent = { name: tool.name, input, callbacks, readOnly: tool.readOnly };
  const observations = await Promise.all(
    [...executionObservers].map(async (observer) => {
      try {
        return { observer, state: await observer.before?.(event) };
      } catch {
        return { observer, state: undefined };
      }
    }),
  );

  let result: ToolResult | undefined;
  let error: unknown;
  try {
    result = await tool.executeTimed(input, callbacks);
    return result;
  } catch (caught) {
    error = caught;
    throw caught;
  } finally {
    await Promise.all(
      observations.map(async ({ observer, state }) => {
        try {
          await observer.after?.({ ...event, result, error, state });
        } catch {
          // Observers are diagnostic extensions and must not break tool execution.
        }
      }),
    );
  }
}

export function getToolDisplayText(name: string, input: ToolInput): string {
  const tool = findTool(name);
  if (!tool) return `未知工具: ${name}`;
  try {
    return tool.onToolUseDisplayText(input);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return `工具 ${name} onToolUseDisplayText 执行失败：\n${message}`;
  }
}

export function isToolReadOnly(name: string): boolean {
  const tool = findTool(name);
  return tool?.readOnly === true;
}

/** 按工具及输入判断能否与同一条消息里其余调用重叠执行（见 `ToolScheduleOptions`）。 */
export function isToolOverlappable(name: string, input?: ToolInput): boolean {
  const tool = findTool(name);
  return tool ? (input === undefined ? tool.overlappable : tool.canOverlap(input)) : false;
}

export function isToolPrimaryAgentOnly(name: string): boolean {
  const tool = findTool(name);
  return tool ? runtimeToolOptions.get(tool)?.primaryAgentOnly === true : false;
}
