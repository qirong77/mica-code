import { micaTools, type ToolInput } from '@packages/mica-tools/index.js';
import type { AgentCallbacks } from '../core/Agent.js';
import { throwIfQueryStopped } from '../core/retry.js';
import type { ModelClientOptions } from './types.js';

export { throwIfQueryStopped };

export function interruptedToolOutput(): string {
  return JSON.stringify({
    ok: false,
    status: 'interrupted',
    error: 'Previous tool execution was interrupted before producing output.',
  });
}

export async function executeProviderToolCall(params: {
  name: string;
  argsText: string;
  id?: string;
  parseArgs: () => ToolInput;
  signal?: AbortSignal;
  context: unknown;
  toolFilter: ModelClientOptions['toolFilter'];
  onToolCall?: AgentCallbacks['onToolCall'];
  onToolResult?: AgentCallbacks['onToolResult'];
}): Promise<{ result: string; isError: boolean }> {
  params.onToolCall?.(params.name, params.argsText, params.id);
  let result: string;
  let isError = false;
  try {
    result = await micaTools.execute(
      params.name,
      params.parseArgs(),
      { signal: params.signal, context: params.context },
      params.toolFilter,
    );
  } catch (error) {
    isError = true;
    result = `工具执行失败: ${error instanceof Error ? error.message : String(error)}`;
  }
  params.onToolResult?.(params.name, result, params.id);
  return { result, isError };
}
