import type Anthropic from '@anthropic-ai/sdk';

import { ToolReadFile } from './ToolReadFile.js';
import { ToolWriteFile } from './ToolWriteFile.js';
import { ToolEditFile } from './ToolEditFile.js';
import { ToolListFiles } from './ToolListFiles.js';
import { ToolGrepSearch } from './ToolGrepSearch.js';
import { ToolWebFetch } from './ToolWebFetch.js';
import { ToolWebSearch } from './ToolWebSearch.js';

import { MicaTool } from './MicaTool.js';
import { ToolRunShell } from './ToolRunShell.js';
import { ToolSkill } from './ToolSkill.js';
import type { ToolExecuteCallbacks } from './MicaTool.js';

const builtinTools: MicaTool[] = [
  new ToolReadFile(),
  new ToolWriteFile(),
  new ToolEditFile(),
  new ToolListFiles(),
  new ToolGrepSearch(),
  new ToolRunShell(),
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

function findTool(name: string): MicaTool | undefined {
  const exact = getAllTools().find((t) => t.name === name);
  if (exact) return exact;
  return getAllTools().find((t) => t.name.endsWith(`__${name}`));
}

export function getToolDefinitions(): Anthropic.Tool[] {
  return getAllTools().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

export async function executeTool(name: string, input: Record<string, any>, callbacks?: ToolExecuteCallbacks): Promise<string> {
  const tool = findTool(name);
  if (!tool) return `未知工具: ${name}`;

  const validation = tool.validateInput(input);
  if (!validation.valid) {
    return `工具 ${name} 输入校验失败：${validation.message}`;
  }

  return await tool.executeTimed(input, callbacks);
}

export function getToolDisplayText(name: string, input: Record<string, any>): string {
  const tool = findTool(name);
  if (!tool) return `未知工具: ${name}`;
  try {
    return tool.onToolUseDisplayText(input);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return `工具 ${name} onToolUseDisplayText 执行失败：\n${message}`;
  }
}
