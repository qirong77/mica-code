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
 * Calls declared overlappable (such as `wait_for`, `pty_wait`, or `agent await/join`)
 * start when reached and overlap the calls that follow them; their outcome is
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
  // 调度和执行共用解析结果，包括解析失败；不能为了分类重复调用 parseArgs。
  const calls = params.calls.map((call) => {
    let parsed: { input: ToolInput } | { error: unknown } | undefined;
    return {
      ...call,
      parseArgs: () => {
        if (!parsed) {
          try {
            parsed = { input: call.parseArgs() };
          } catch (error) {
            parsed = { error };
          }
        }
        if ('error' in parsed) throw parsed.error;
        return parsed.input;
      },
    };
  });
  // 位置即调用顺序：重叠执行的等待和普通批次完成后都回填到自己的下标。
  const outcomes: Array<ProviderToolCallOutcome | undefined> = new Array(params.calls.length);
  const overlapped: Promise<void>[] = [];
  const started: Promise<void>[] = [];
  let parallelBatch: Promise<void>[] = [];
  const cancellation = new AbortController();
  const signal = params.signal ? AbortSignal.any([params.signal, cancellation.signal]) : cancellation.signal;

  const runCall = async (call: ProviderToolCall, position: number): Promise<void> => {
    const outcome = await executeProviderToolCall({
      name: call.name,
      argsText: call.argsText,
      id: call.id,
      parseArgs: call.parseArgs,
      signal,
      context: params.context,
      toolFilter: params.toolFilter,
      onToolCall: params.onToolCall,
      onToolResult: params.onToolResult,
    });
    outcomes[position] = { name: call.name, id: call.id, ...outcome };
  };

  const startCall = (call: ProviderToolCall, position: number): Promise<void> => {
    const execution = runCall(call, position);
    // 重叠调用可能在屏障回收之前失败，立即登记 rejection handler。
    void execution.catch(() => {});
    started.push(execution);
    return execution;
  };

  const finishParallelBatch = async (): Promise<void> => {
    await Promise.all(parallelBatch);
    parallelBatch = [];
    params.checkpoint?.();
  };

  try {
    for (const [index, current] of calls.entries()) {
      params.checkpoint?.();
      if (isOverlappableTool(current)) {
        overlapped.push(startCall(current, index));
        continue;
      }

      if (isParallelSafeTool(current.name)) {
        // 等待不结束普通并发批次：run A / join T / run B 中 A、B 仍须并发。
        parallelBatch.push(startCall(current, index));
      } else {
        await finishParallelBatch();
        await startCall(current, index);
        params.checkpoint?.();
      }
    }
    await finishParallelBatch();
    await Promise.all(overlapped);
    params.checkpoint?.();
  } catch (error) {
    // shouldContinue 等 checkpoint 停止不一定会 abort 外部 signal，须主动取消已启动调用。
    cancellation.abort(error);
    await Promise.allSettled(started);
    throw error;
  }

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
  if (name === 'agent') return true;
  try {
    return micaTools.isReadOnly(name);
  } catch {
    return false;
  }
}

function isOverlappableTool(call: ProviderToolCall): boolean {
  try {
    return micaTools.isOverlappable(call.name, call.parseArgs());
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
