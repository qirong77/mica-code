import type { Tool } from './types.js';
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
import type { ToolExecuteCallbacks, ToolInput } from './MicaTool.js';

export type ToolFilter = (name: string) => boolean;

export type ToolExecutionEvent = {
  name: string;
  input: ToolInput;
  callbacks?: ToolExecuteCallbacks;
  readOnly: boolean;
};

export type ToolExecutionObserver = {
  before?(event: ToolExecutionEvent): unknown | Promise<unknown>;
  after?(event: ToolExecutionEvent & { result?: string; error?: unknown; state?: unknown }): void | Promise<void>;
};

const builtinTools: MicaTool[] = [
  new ToolReadFile(),
  new ToolWriteFile(),
  new ToolApplyPatch(),
  new ToolListFiles(),
  new ToolGrepSearch(),
  new ToolRunShell(),
  new ToolBackgroundTasks(),
  new ToolReadTaskOutput(),
  new ToolKillTask(),
  new ToolWebFetch(),
  new ToolWebSearch(),
  new ToolSkill(),
];

let mcpTools: MicaTool[] = [];
let runtimeTools: MicaTool[] = [];
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

export function registerRuntimeTool(tool: MicaTool): void {
  runtimeTools = [...runtimeTools.filter((entry) => entry.name !== tool.name), tool];
}

export function unregisterRuntimeTool(nameOrTool: string | MicaTool): void {
  const name = typeof nameOrTool === 'string' ? nameOrTool : nameOrTool.name;
  runtimeTools = runtimeTools.filter((tool) => tool.name !== name);
}

export function unregisterRuntimeTools(): void {
  runtimeTools = [];
}

function getAllTools(): MicaTool[] {
  return [...builtinTools, ...runtimeTools, ...mcpTools];
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
  return {
    builtin: builtinTools.length,
    runtime: runtimeTools.length,
    mcp: mcpTools.length,
    total: builtinTools.length + runtimeTools.length + mcpTools.length,
  };
}

export async function executeTool(
  name: string,
  input: ToolInput,
  callbacks?: ToolExecuteCallbacks,
  filter?: ToolFilter,
): Promise<string> {
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

  let result: string | undefined;
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
