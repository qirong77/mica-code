import type { Tool, ToolResult } from './types.js';
import type { Disposable } from '@packages/mica-common/index.js';

import { ToolReadFile } from './ToolReadFile.js';
import { ToolWriteFile } from './ToolWriteFile.js';
import { ToolApplyPatch } from './ToolApplyPatch.js';
import { ToolListFiles } from './ToolListFiles.js';
import { ToolGrepSearch } from './ToolGrepSearch.js';
import { ToolWebFetch } from './ToolWebFetch.js';
import { ToolWebSearch } from './ToolWebSearch.js';
import { ToolSkill } from './ToolSkill.js';
import { MicaTool } from './MicaTool.js';
import { ToolRunShell } from './ToolRunShell.js';
import { ToolBackgroundStart } from './ToolBackgroundStart.js';
import { ToolBackgroundTasks } from './ToolBackgroundTasks.js';
import { ToolBackgroundRead } from './ToolBackgroundRead.js';
import { ToolKillTask } from './ToolKillTask.js';
import { ToolReadImage } from './ToolReadImage.js';
import { ToolWaitFor } from './ToolWaitFor.js';
import type { ToolExecuteCallbacks, ToolInput, ToolSource } from './MicaTool.js';
import { ToolPtySpawn } from './pty/ToolPtySpawn.js';
import { ToolPtySend } from './pty/ToolPtySend.js';
import { ToolPtyRead } from './pty/ToolPtyRead.js';
import { ToolPtyWait } from './pty/ToolPtyWait.js';
import { ToolPtyKill } from './pty/ToolPtyKill.js';
import { RUNTIME_TOOL_DESCRIPTORS } from './runtimeToolDescriptors.js';

export type ToolFilter = (name: string) => boolean;

export type RuntimeToolRegistrationOptions = {
  primaryAgentOnly?: boolean;
};

export type ToolCatalogEntry = {
  name: string;
  description: string;
  source: ToolSource;
  /** Original MCP server name for `source: 'mcp'` entries. */
  mcpServer?: string;
  readOnly: boolean;
  /** 入参摘要：能力面板的详情要能说清这个工具吃什么，不用去翻代码。 */
  parameters: ToolParameterEntry[];
  /** 所属工具族（共享名字前缀，如 `pty_*`）；`null` 表示独立工具，面板平铺。 */
  group: ToolGroupEntry | null;
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
 * 工具族的显示名。只有真正同族的工具（共享名字前缀且不止一个成员，如 `pty_*`）才成组，
 * 其余工具一律平铺——它们之间没有共同的调用语义，硬凑成「文件 / 命令」这类类别反而
 * 让人看不出这个组到底改动了什么。新增族时在这里补中文名，缺省用前缀本身。
 */
const TOOL_FAMILY_LABELS: Record<string, string> = {
  pty: '交互终端',
  session: '会话自治',
  loop: '定时循环',
  background_tasks: '后台任务',
};

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
  new ToolWebSearch(),
  new ToolSkill(),
  new ToolPtySpawn(),
  new ToolPtySend(),
  new ToolPtyRead(),
  new ToolPtyWait(),
  new ToolPtyKill(),
];

let mcpTools: MicaTool[] = [];
let runtimeTools: MicaTool[] = [];
const runtimeToolOptions = new WeakMap<MicaTool, RuntimeToolRegistrationOptions>();
const executionObservers = new Set<ToolExecutionObserver>();

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

export function registerRuntimeTool(tool: MicaTool, options: RuntimeToolRegistrationOptions = {}): void {
  runtimeTools = [...runtimeTools.filter((entry) => entry !== tool), tool];
  runtimeToolOptions.set(tool, options);
}

export function unregisterRuntimeTool(nameOrTool: string | MicaTool): void {
  runtimeTools =
    typeof nameOrTool === 'string'
      ? runtimeTools.filter((tool) => tool.name !== nameOrTool)
      : runtimeTools.filter((tool) => tool !== nameOrTool);
}

export function unregisterRuntimeTools(): void {
  runtimeTools = [];
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

function findTool(name: string): MicaTool | undefined {
  const exact = getAllTools().find((t) => t.name === name);
  if (exact) return exact;
  return getAllTools().find((t) => t.name.endsWith(`__${name}`));
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
    source: tool.source === 'mcp' ? 'mcp' : 'builtin',
    mcpServer: tool.mcpServer,
    readOnly: tool.readOnly,
    parameters: toolParameters(tool),
    group: families.get(tool.name) ?? null,
  }));
  // 运行期工具只存在于跑 agent 的进程里：配置页 / 桌面设置页不加载插件，目录会缺
  // TodoWrite 这类工具，「新会话默认值」里就关不掉它们。未注册时用描述补一行。
  for (const descriptor of RUNTIME_TOOL_DESCRIPTORS) {
    if (registered.has(descriptor.name)) continue;
    entries.push({
      ...descriptor,
      source: 'builtin',
      group: families.get(descriptor.name) ?? null,
    });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
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

/** 纯等待工具：可以与同一条消息里其余工具调用重叠执行（见 `ToolScheduleOptions`）。 */
export function isToolOverlappable(name: string): boolean {
  const tool = findTool(name);
  return tool?.overlappable === true;
}

export function isToolPrimaryAgentOnly(name: string): boolean {
  const tool = findTool(name);
  return tool ? runtimeToolOptions.get(tool)?.primaryAgentOnly === true : false;
}
