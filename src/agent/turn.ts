import Anthropic from '@anthropic-ai/sdk';
import { systemPrompt } from '../prompts/index';
import { executeTool, toolDefinitions } from '../tools/index';
import { messagesAtom } from '../store/conversation.js';
import { EFFORT_TOKENS, model } from '../store/config.js';
import { appendSystemLog } from '../store/logAtom.js';
import type { WorkingStatus } from '../store/ui-state.js';
import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream.mjs';
import { getClient } from './client.js';
import { clearBackups } from '../utils/fileHistory.js';
import mitt from 'mitt';

export type AgentTurnEvents = {
  'stream:create': MessageStream<null>;
  'tool:use': {
    toolUseId: string;
    toolName: string;
    toolInput: Record<string, any>;
    completed: boolean;
  };
  status: WorkingStatus;
  'log:chunk': { toolUseId: string; chunk: string };
};

export interface IterationResult {
  hasToolUse: boolean;
  wasTruncated: boolean;
  finalMessage: Anthropic.Message;
}

export type RunFn = (
  userInput: string,
  onIteration?: (result: IterationResult) => void,
) => Promise<void>;
export type Middleware = (
  userInput: string,
  next: RunFn,
  onIteration?: (result: IterationResult) => void,
) => Promise<void>;

class AgentTurn {
  readonly events = mitt<AgentTurnEvents>();

  private middlewares: Middleware[] = [];

  use(middleware: Middleware) {
    this.middlewares.push(middleware);
  }

  async executeSingleIteration(): Promise<IterationResult> {
    const messages = messagesAtom.get();
    const modelName = model.atom.get();
    const effort = model.effort.get();

    appendSystemLog(`迭代开始：model=${modelName} effort=${effort}`);
    this.events.emit('status', { type: 'connecting' });

    const stream = getClient().messages.stream({
      model: modelName,
      max_tokens: model.maxTokens.get(),
      system: systemPrompt,
      messages,
      thinking:
        effort === 'none'
          ? { type: 'disabled' as const }
          : { type: 'enabled' as const, budget_tokens: EFFORT_TOKENS[effort] },
      output_config: effort !== 'none' ? { effort } : undefined,
      tools: toolDefinitions,
    }) as MessageStream<null>;

    this.events.emit('stream:create', stream);

    let hasToolUse = false;
    const completedToolUses: Array<{ id: string; name: string; input: Record<string, any> }> = [];
    stream.on('contentBlock', (content) => {
      if (content.type === 'tool_use') {
        hasToolUse = true;
        const tool = {
          id: content.id,
          name: content.name,
          input: content.input as Record<string, any>,
        };
        completedToolUses.push(tool);
        this.events.emit('tool:use', {
          toolUseId: tool.id,
          toolName: tool.name,
          toolInput: tool.input,
          completed: false,
        });
      }
    });

    const finalMessage = await stream.finalMessage();
    const wasTruncated = finalMessage.stop_reason === 'max_tokens';
    messagesAtom.set([...messages, finalMessage]);
    appendSystemLog(
      `迭代响应：${completedToolUses.length > 0 ? `${completedToolUses.length} 个工具调用` : '无工具调用'}${wasTruncated ? ' [因 max_tokens 截断]' : ''}`,
    );

    if (completedToolUses.length > 0) {
      const toolStartTime = Date.now();
      this.events.emit('status', { type: 'calling_tool' });

      const timer = setInterval(() => {
        this.events.emit('status', {
          type: 'calling_tool',
          elapsedMs: Date.now() - toolStartTime,
        });
      }, 200);

      const SLOW_TOOL_THRESHOLD_MS = 3000;
      const toolTimers = new Map<string, { name: string; startTime: number; lastLogTime: number }>();
      const slowToolTimer = setInterval(() => {
        const now = Date.now();
        for (const [id, info] of toolTimers) {
          const elapsed = now - info.startTime;
          if (elapsed >= SLOW_TOOL_THRESHOLD_MS && now - info.lastLogTime >= SLOW_TOOL_THRESHOLD_MS) {
            appendSystemLog(`工具 ${info.name} 已执行 ${(elapsed / 1000).toFixed(1)}s`);
            info.lastLogTime = now;
          }
        }
      }, SLOW_TOOL_THRESHOLD_MS);

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      const settled = await Promise.allSettled(
        completedToolUses.map(async (tool) => {
          const startTime = Date.now();
          toolTimers.set(tool.id, { name: tool.name, startTime, lastLogTime: 0 });
          const result = await executeTool(tool.name, tool.input, {
            onChunk: (chunk) => {
              this.events.emit('log:chunk', { toolUseId: tool.id, chunk });
            },
          });
          const elapsed = Date.now() - startTime;
          toolTimers.delete(tool.id);
          if (elapsed >= SLOW_TOOL_THRESHOLD_MS) {
            appendSystemLog(`工具 ${tool.name} 执行完成，耗时 ${(elapsed / 1000).toFixed(1)}s`);
          }
          return { tool, result };
        }),
      );

      clearInterval(timer);
      clearInterval(slowToolTimer);

      for (let i = 0; i < settled.length; i++) {
        const item = settled[i];
        const tool = completedToolUses[i];
        const result =
          item.status === 'fulfilled'
            ? item.value.result
            : `工具 ${tool.name} 执行异常：\n${
                item.reason instanceof Error
                  ? `${item.reason.name}: ${item.reason.message}`
                  : String(item.reason)
              }`;
        toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: result });

        this.events.emit('tool:use', {
          toolUseId: tool.id,
          toolName: tool.name,
          toolInput: tool.input,
          completed: true,
        });

        if (item.status === 'rejected') {
          this.events.emit('status', {
            type: 'error',
            message: item.reason instanceof Error ? item.reason.message : String(item.reason),
          });
        }
      }

      const withToolResults = [
        ...messagesAtom.get(),
        { role: 'user', content: toolResults } as Anthropic.MessageParam,
      ];
      messagesAtom.set(withToolResults);
    }

    if (!hasToolUse) {
      this.events.emit('status', { type: 'idle' });
    }
    return { hasToolUse, wasTruncated, finalMessage };
  }

  private async _coreRun(userInput: string, onIteration?: (result: IterationResult) => void) {
    appendSystemLog('Agent run 开始');
    await clearBackups();
    const updated = [...messagesAtom.get(), { role: 'user', content: userInput } as Anthropic.MessageParam];
    messagesAtom.set(updated);
    while (true) {
      const result = await this.executeSingleIteration();
      onIteration?.(result);
      if (!result.hasToolUse && !result.wasTruncated) {
        appendSystemLog('Agent run 结束（无待执行工具）');
        return;
      }
      appendSystemLog(`继续下一轮迭代（${result.wasTruncated ? '响应被截断' : '存在工具调用'}）`);
    }
  }

  async run(userInput: string, onIteration?: (result: IterationResult) => void) {
    const coreRun: RunFn = this._coreRun.bind(this);
    const chain = this.middlewares.reduceRight<RunFn>(
      (next, mw) => (input, cb) => mw(input, next, cb),
      coreRun,
    );
    return chain(userInput, onIteration);
  }
}

export const agentTurn = new AgentTurn();
