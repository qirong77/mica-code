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
import { ToolBackgroundTasks } from './ToolBackgroundTasks.js';
import { ToolReadTaskOutput } from './ToolReadTaskOutput.js';
import { ToolKillTask } from './ToolKillTask.js';
import { ToolReadImage } from './ToolReadImage.js';
import { ToolWaitFor } from './ToolWaitFor.js';
import type { ToolExecuteCallbacks, ToolInput } from './MicaTool.js';
import { ToolPtySpawn } from './pty/ToolPtySpawn.js';
import { ToolPtySend } from './pty/ToolPtySend.js';
import { ToolPtyRead } from './pty/ToolPtyRead.js';
import { ToolPtyWait } from './pty/ToolPtyWait.js';
import { ToolPtyKill } from './pty/ToolPtyKill.js';

export type ToolFilter = (name: string) => boolean;

export type RuntimeToolRegistrationOptions = {
  primaryAgentOnly?: boolean;
};

export type ToolCatalogEntry = {
  name: string;
  description: string;
  source: 'builtin' | 'runtime' | 'mcp';
  /** Original MCP server name for `source: 'mcp'` entries. */
  mcpServer?: string;
  readOnly: boolean;
  /** 入参摘要：能力面板的详情要能说清这个工具吃什么，不用去翻代码。 */
  parameters: ToolParameterEntry[];
  /** 所属分组：能力面板按组展示、按组开关（pty_* 这类工具单独一行没有意义）。 */
  group: ToolGroupEntry;
};

export type ToolGroupEntry = {
  key: string;
  label: string;
  /** 面板里的组顺序：目录本身按名字排序，分组后要回到「常用 → 少见」的阅读顺序。 */
  order: number;
};

export type ToolParameterEntry = {
  name: string;
  type: string;
  required: boolean;
  description: string;
};

/**
 * 工具分组表：能力面板按组展示与开关的唯一来源。
 *
 * 显式名字表优先（同一组的工具未必共享前缀，例如 `run_shell` 与 `kill_task`），
 * 其次按名字前缀匹配（`pty_*`、`session_*`、`loop_*` 这类插件工具族），最后落进
 * 「其他工具」。新增工具时优先补 `TOOL_NAMES` 或让名字沿用已有前缀。
 */
const TOOL_GROUPS: Record<string, ToolGroupEntry> = {
  file: { key: 'file', label: '文件读取', order: 10 },
  edit: { key: 'edit', label: '文件修改', order: 20 },
  shell: { key: 'shell', label: '命令与后台任务', order: 30 },
  pty: { key: 'pty', label: '交互终端', order: 40 },
  web: { key: 'web', label: '联网检索', order: 50 },
  skill: { key: 'skill', label: '技能', order: 60 },
  session: { key: 'session', label: '会话自治', order: 70 },
  loop: { key: 'loop', label: '定时循环', order: 80 },
  subagent: { key: 'subagent', label: '子代理', order: 90 },
  todo: { key: 'todo', label: '任务清单', order: 100 },
  other: { key: 'other', label: '其他工具', order: 1000 },
};

const TOOL_NAME_GROUPS: Record<string, string> = {
  read_file: 'file',
  read_image: 'file',
  list_files: 'file',
  grep_search: 'file',
  write_file: 'edit',
  apply_patch: 'edit',
  run_shell: 'shell',
  background_tasks: 'shell',
  read_task_output: 'shell',
  kill_task: 'shell',
  wait_for: 'shell',
  web_fetch: 'web',
  web_search: 'web',
  pty_spawn: 'pty',
  pty_send: 'pty',
  pty_read: 'pty',
  pty_wait: 'pty',
  pty_kill: 'pty',
  Skill: 'skill',
  Agent: 'subagent',
  TodoWrite: 'todo',
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
  new ToolBackgroundTasks(),
  new ToolReadTaskOutput(),
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
  if (tool.source !== 'mcp') tool.source = 'runtime';
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

export function getToolCounts(): { builtin: number; runtime: number; mcp: number; total: number } {
  const runtimeCount = getActiveRuntimeTools().length;
  return {
    builtin: builtinTools.length,
    runtime: runtimeCount,
    mcp: mcpTools.length,
    total: builtinTools.length + runtimeCount + mcpTools.length,
  };
}

/** Full tool directory (enabled or not) for the capability panel. */
export function getToolCatalog(): ToolCatalogEntry[] {
  return getAllToolsForPrompt().map((tool) => ({
    name: tool.name,
    description: tool.description,
    source: tool.source,
    mcpServer: tool.mcpServer,
    readOnly: tool.readOnly,
    parameters: toolParameters(tool),
    group: toolGroup(tool.name),
  }));
}

/** 名字表 → 前缀族（`session_peers` 之类插件工具）→ 「其他工具」。 */
function toolGroup(name: string): ToolGroupEntry {
  const explicit = TOOL_NAME_GROUPS[name];
  if (explicit) return TOOL_GROUPS[explicit];
  const prefix = name.includes('_') ? name.slice(0, name.indexOf('_')) : '';
  if (prefix && TOOL_GROUPS[prefix] && TOOL_GROUPS[prefix].key !== 'other') {
    return TOOL_GROUPS[prefix];
  }
  return TOOL_GROUPS.other;
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

export function isToolPrimaryAgentOnly(name: string): boolean {
  const tool = findTool(name);
  return tool ? runtimeToolOptions.get(tool)?.primaryAgentOnly === true : false;
}
