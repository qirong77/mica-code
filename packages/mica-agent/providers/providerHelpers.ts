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

export type ProviderToolCall = {
  name: string;
  argsText: string;
  id?: string;
  parseArgs: () => ToolInput;
};

export type ProviderToolCallOutcome = {
  name: string;
  id?: string;
  result: string;
  images: ToolResultImageBlock[];
  isError: boolean;
};

/**
 * Executes the tool calls of one provider message. A maximal run of
 * parallel-safe calls (read-only tools and `Agent`) runs concurrently; any
 * other tool is a serial barrier of its own, so write/exec side effects keep
 * their declared order. Outcomes come back in the original call order.
 *
 * `checkpoint` is invoked before and after every batch, preserving the
 * existing abort checkpoints (`throwIfQueryStopped`) of the provider loop.
 */
export async function executeProviderToolCalls(params: {
  calls: ProviderToolCall[];
  signal?: AbortSignal;
  context: unknown;
  toolFilter: ModelClientOptions['toolFilter'];
  onToolCall?: AgentCallbacks['onToolCall'];
  onToolResult?: AgentCallbacks['onToolResult'];
  checkpoint?: () => void;
}): Promise<ProviderToolCallOutcome[]> {
  const outcomes: ProviderToolCallOutcome[] = [];
  let index = 0;

  while (index < params.calls.length) {
    const batch: ProviderToolCall[] = [];
    if (isParallelSafeTool(params.calls[index]!.name)) {
      while (index < params.calls.length && isParallelSafeTool(params.calls[index]!.name)) {
        batch.push(params.calls[index++]!);
      }
    } else {
      batch.push(params.calls[index++]!);
    }

    params.checkpoint?.();
    const batchOutcomes = await Promise.all(
      batch.map(async (call) => {
        const outcome = await executeProviderToolCall({
          name: call.name,
          argsText: call.argsText,
          id: call.id,
          parseArgs: call.parseArgs,
          signal: params.signal,
          context: params.context,
          toolFilter: params.toolFilter,
          onToolCall: params.onToolCall,
          onToolResult: params.onToolResult,
        });
        return { name: call.name, id: call.id, ...outcome };
      }),
    );
    params.checkpoint?.();
    outcomes.push(...batchOutcomes);
  }

  return outcomes;
}

/**
 * Read-only tools never mutate local state, and `Agent` calls own their child
 * agent/task state, so both are safe to run concurrently. Everything else
 * (write/exec tools) must stay serial.
 */
function isParallelSafeTool(name: string): boolean {
  if (name === 'Agent') return true;
  try {
    return micaTools.isReadOnly(name);
  } catch {
    return false;
  }
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
      { signal: params.signal, context: withToolCallId(params.context, params.id) },
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

/**
 * Injects the provider tool-call id into the execution context so tools that
 * spawn work (e.g. the Agent tool) can record which parent invocation
 * initiated it. A shallow copy keeps the original context untouched.
 */
function withToolCallId(context: unknown, callId: string | undefined): unknown {
  if (!callId || (context && typeof context !== 'object')) return context;
  if (context === null || context === undefined) return { toolCallId: callId };
  return { ...(context as Record<string, unknown>), toolCallId: callId };
}
