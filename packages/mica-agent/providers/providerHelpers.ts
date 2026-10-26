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
 * Tools declared `overlappable` (pure waits such as `wait_for` / `pty_wait`)
 * start immediately and overlap the calls that follow them; their outcome is
 * collected after every other call settled. Without that, a long poll would
 * block the work the model wanted to do while waiting.
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
  // 位置即调用顺序：重叠执行的等待和普通批次完成后都回填到自己的下标。
  const outcomes: Array<ProviderToolCallOutcome | undefined> = new Array(params.calls.length);
  const overlapped: Promise<void>[] = [];
  let index = 0;

  const runCall = async (call: ProviderToolCall, position: number): Promise<void> => {
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
    outcomes[position] = { name: call.name, id: call.id, ...outcome };
  };

  try {
    while (index < params.calls.length) {
      const current = params.calls[index]!;
      if (isOverlappableTool(current.name)) {
        params.checkpoint?.();
        overlapped.push(runCall(current, index));
        index += 1;
        continue;
      }

      const batchStart = index;
      const batch: ProviderToolCall[] = [];
      if (isParallelSafeTool(params.calls[index]!.name)) {
        while (index < params.calls.length && isParallelSafeTool(params.calls[index]!.name)) {
          batch.push(params.calls[index++]!);
        }
      } else {
        batch.push(params.calls[index++]!);
      }

      params.checkpoint?.();
      await Promise.all(batch.map(async (call, offset) => runCall(call, batchStart + offset)));
      params.checkpoint?.();
    }
  } catch (error) {
    // 批次被中止时别把重叠的等待留成未处理的 rejection。
    await Promise.allSettled(overlapped);
    throw error;
  }

  await Promise.all(overlapped);
  return outcomes.map((outcome, position) => {
    if (!outcome) throw new Error(`工具调用 ${params.calls[position]?.name ?? position} 没有产出结果`);
    return outcome;
  });
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

function isOverlappableTool(name: string): boolean {
  try {
    return micaTools.isOverlappable(name);
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
