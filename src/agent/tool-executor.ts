import type Anthropic from '@anthropic-ai/sdk';
import { executeTool } from '../tools/index.js';
import { sessionToolRecordsAtom } from '../store/logAtom.js';
import type { WorkingStatus } from '../store/ui-state.js';
import type { CompletedToolUse } from './types.js';

const MAX_TOOL_RECORDS = 100;

export type ToolExecutorCallbacks = {
  onToolUse: (payload: {
    toolUseId: string;
    toolName: string;
    toolInput: Record<string, any>;
    completed: boolean;
    elapsedMs?: number;
  }) => void;
  onToolOutput: (payload: { toolUseId: string; chunk: string }) => void;
  onStatus: (status: WorkingStatus) => void;
};

export class ToolExecutor {
  constructor(private callbacks: ToolExecutorCallbacks) {}

  async execute(
    tools: CompletedToolUse[],
    abortSignal: AbortSignal,
    iterationId?: number,
  ): Promise<Anthropic.ToolResultBlockParam[]> {
    if (tools.length === 0) return [];

    const toolStartTime = Date.now();
    const toolNames = tools.map((t) => t.name);
    this.callbacks.onStatus({ type: 'calling_tool', toolNames });

    const timer = setInterval(() => {
      this.callbacks.onStatus({
        type: 'calling_tool',
        elapsedMs: Date.now() - toolStartTime,
        toolNames,
      });
    }, 200);

    const settled = await Promise.allSettled(
      tools.map(async (tool) => {
        if (abortSignal.aborted) throw new Error('ABORT');
        const startTime = Date.now();
        const result = await executeTool(tool.name, tool.input, {
          onChunk: (chunk) => {
            this.callbacks.onToolOutput({ toolUseId: tool.id, chunk });
          },
          signal: abortSignal,
        });
        const elapsed = Date.now() - startTime;
        const records = sessionToolRecordsAtom.get();
        const next = [...records, { toolName: tool.name, toolInput: tool.input, elapsedMs: elapsed }];
        sessionToolRecordsAtom.set(
          next.length > MAX_TOOL_RECORDS ? next.slice(-MAX_TOOL_RECORDS) : next,
        );
        return { tool, result, elapsed };
      }),
    );

    clearInterval(timer);

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (let i = 0; i < settled.length; i++) {
      const item = settled[i];
      const tool = tools[i];
      const result =
        item.status === 'fulfilled'
          ? item.value.result
          : `工具 ${tool.name} 执行异常：\n${
              item.reason instanceof Error
                ? `${item.reason.name}: ${item.reason.message}`
                : String(item.reason)
            }`;
      toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: result });

      this.callbacks.onToolUse({
        toolUseId: tool.id,
        toolName: tool.name,
        toolInput: tool.input,
        completed: true,
        elapsedMs: item.status === 'fulfilled' ? item.value.elapsed : undefined,
      });

      if (item.status === 'rejected') {
        this.callbacks.onStatus({
          type: 'error',
          message: item.reason instanceof Error ? item.reason.message : String(item.reason),
        });
      }
    }

    return toolResults;
  }
}
