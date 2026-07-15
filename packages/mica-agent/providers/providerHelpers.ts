import {
  micaTools,
  toolResultToText,
  type ToolInput,
  type ToolResult,
  type ToolResultImageBlock,
} from '@packages/mica-tools/index.js';
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
}): Promise<{ result: string; images: ToolResultImageBlock[]; isError: boolean }> {
  params.onToolCall?.(params.name, params.argsText, params.id);
  let rawResult: ToolResult;
  let isError = false;
  try {
    rawResult = await micaTools.execute(
      params.name,
      params.parseArgs(),
      { signal: params.signal, context: params.context },
      params.toolFilter,
    );
  } catch (error) {
    isError = true;
    rawResult = `工具执行失败: ${error instanceof Error ? error.message : String(error)}`;
  }
  const result = toolResultToText(rawResult);
  const images =
    typeof rawResult === 'string'
      ? []
      : rawResult.filter((block): block is ToolResultImageBlock => block.type === 'image');
  params.onToolResult?.(params.name, result, params.id);
  return { result, images, isError };
}
