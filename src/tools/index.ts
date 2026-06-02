import type Anthropic from '@anthropic-ai/sdk';

import { ToolReadFile } from './ToolReadFile';
import { ToolWriteFile } from './ToolWriteFile';
import { ToolEditFile } from './ToolEditFile';
import { ToolListFiles } from './ToolListFiles';
import { ToolGrepSearch } from './ToolGrepSearch';
import { ToolWebFetch } from './ToolWebFetch';

import { MicaTool } from './MicaTool';
import { ToolRunShell } from './ToolRunShell';
import { ToolSkill } from './ToolSkill';
import type { ToolExecuteCallbacks } from './MicaTool';
import { backupFile } from '../utils/fileHistory.js';

const builtinTools: MicaTool[] = [
  new ToolReadFile(),
  new ToolWriteFile(),
  new ToolEditFile(),
  new ToolListFiles(),
  new ToolGrepSearch(),
  new ToolRunShell(),
  new ToolWebFetch(),
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

export function getToolDefinitions(): Anthropic.Tool[] {
  return getAllTools().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

export async function executeTool(name: string, input: Record<string, any>, callbacks?: ToolExecuteCallbacks): Promise<string> {
  const tool = getAllTools().find((t) => t.name === name);
  if (!tool) return `未知工具: ${name}`;

  if (name === 'write_file' || name === 'edit_file') {
    await backupFile(input.file_path as string);
  }
  return await tool.executeTimed(input, callbacks);
}

export function getToolDisplayText(name: string, input: Record<string, any>): string {
  const tool = getAllTools().find((t) => t.name === name);
  if (!tool) return `未知工具: ${name}`;
  try {
    return tool.onToolUseDisplayText(input);
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return `工具 ${name} onToolUseDisplayText 执行失败：\n${message}`;
  }
}
