import type { Tool } from './types.js';

import { ToolReadFile } from './ToolReadFile.js';
import { ToolWriteFile } from './ToolWriteFile.js';
import { ToolEditFile } from './ToolEditFile.js';
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

const builtinTools: MicaTool[] = [
  new ToolReadFile(),
  new ToolWriteFile(),
  new ToolEditFile(),
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

export function registerMcpTools(tools: MicaTool[]): void {
  mcpTools = tools;
}

export function unregisterMcpTools(): void {
  mcpTools = [];
}

function getAllTools(): MicaTool[] {
  return [...builtinTools, ...mcpTools];
}

function getAllToolsForPrompt(): MicaTool[] {
  return getAllTools().sort((a, b) => a.name.localeCompare(b.name));
}

function findTool(name: string): MicaTool | undefined {
  const exact = getAllTools().find((t) => t.name === name);
  if (exact) return exact;
  return getAllTools().find((t) => t.name.endsWith(`__${name}`));
}

export function getToolDefinitions(): Tool[] {
  return getAllToolsForPrompt().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

export function getToolCounts(): { builtin: number; mcp: number; total: number } {
  return {
    builtin: builtinTools.length,
    mcp: mcpTools.length,
    total: builtinTools.length + mcpTools.length,
  };
}

export async function executeTool(name: string, input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
  const tool = findTool(name);
  if (!tool) return `未知工具: ${name}`;

  const validation = tool.validateInput(input);
  if (!validation.valid) {
    return `工具 ${name} 输入校验失败：${validation.message}`;
  }

  return await tool.executeTimed(input, callbacks);
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
