import Anthropic from '@anthropic-ai/sdk';
import { systemPrompt } from '../prompts/index';
import { executeTool, toolDefinitions } from '../tools/index';
import { messagesAtom, contextSizeAtom, updateContextSize, type ConversationMessage } from '../store/conversation.js';
import { EFFORT_TOKENS, model } from '../store/config.js';
import { appendSystemLog, sessionToolRecordsAtom } from '../store/logAtom.js';
import type { WorkingStatus } from '../store/ui-state.js';
import { planModeAtom } from '../store/ui-state.js';
import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream.mjs';
import { getClient } from './client.js';
import { clearBackups } from '../utils/fileHistory.js';
import mitt from 'mitt';
import { parseImageRefs } from '../components/ui/utils/imagePaste.js';

export type AgentTurnEvents = {
  'stream:create': MessageStream<null>;
  'tool:use': {
    toolUseId: string;
    toolName: string;
    toolInput: Record<string, any>;
    completed: boolean;
    elapsedMs?: number;
  };
  status: WorkingStatus;
  'tool:output': { toolUseId: string; chunk: string };
  'message:final': Anthropic.Message;
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

function hasTextContent(message: Anthropic.Message): boolean {
  if (typeof message.content === 'string') return true;
  return message.content.some((block) => block.type === 'text');
}

class AgentTurn {
  readonly events = mitt<AgentTurnEvents>();

  private middlewares: Middleware[] = [];
  private abortController: AbortController | null = null;
  private _aborted = false;

  abort() {
    this._aborted = true;
    this.abortController?.abort();
    this.abortController = null;
  }

  get isAborted() {
    return this._aborted;
  }

  use(middleware: Middleware) {
    this.middlewares.push(middleware);
  }

  async executeSingleIteration(): Promise<IterationResult> {
    const messages = messagesAtom.get();
    const modelName = model.name.get();
    const effort = model.effort.get();

    if (this._aborted) {
      throw new Error('ABORT');
    }

    appendSystemLog(`迭代开始：model=${modelName} effort=${effort}`);
    this.events.emit('status', { type: 'connecting' });

    this.abortController = new AbortController();

    const planReminder = planModeAtom.get()
      ? '\n\n<system-reminder>\n当前处于 plan mode，仅分析规划，不要执行代码修改。\n</system-reminder>'
      : '';

    const stream = getClient().messages.stream({
      model: modelName,
      max_tokens: model.maxTokens.get(),
      system: systemPrompt + planReminder,
      messages: messages as Anthropic.MessageParam[],
      thinking:
        effort === 'none'
          ? { type: 'disabled' as const }
          : { type: 'enabled' as const, budget_tokens: EFFORT_TOKENS[effort] },
      output_config: effort !== 'none' ? { effort } : undefined,
      tools: toolDefinitions,
    }) as MessageStream<null>;

    const abortSignal = this.abortController.signal;

    abortSignal.addEventListener('abort', () => {
      stream.controller.abort();
    }, { once: true });

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

    let finalMessage: Anthropic.Message;
    try {
      finalMessage = await stream.finalMessage();
    } catch (err) {
      if (abortSignal.aborted) {
        throw new Error('ABORT');
      }
      throw err;
    }
    const wasTruncated = finalMessage.stop_reason === 'max_tokens';
    const updatedMessages = [...messages, finalMessage as unknown as ConversationMessage];
    messagesAtom.set(updatedMessages);
    contextSizeAtom.set(updateContextSize(updatedMessages as ConversationMessage[]));
    this.events.emit('message:final', finalMessage);
    appendSystemLog(
      `迭代响应：${completedToolUses.length > 0 ? `${completedToolUses.length} 个工具调用` : '无工具调用'}${wasTruncated ? ' [因 max_tokens 截断]' : ''}`,
    );

    if (completedToolUses.length > 0) {
      const toolStartTime = Date.now();
      const toolNames = completedToolUses.map((t) => t.name);
      this.events.emit('status', { type: 'calling_tool', toolNames });

      const timer = setInterval(() => {
        this.events.emit('status', {
          type: 'calling_tool',
          elapsedMs: Date.now() - toolStartTime,
          toolNames,
        });
      }, 200);

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      const settled = await Promise.allSettled(
        completedToolUses.map(async (tool) => {
          if (abortSignal.aborted) throw new Error('ABORT');
          const startTime = Date.now();
          const result = await executeTool(tool.name, tool.input, {
            onChunk: (chunk) => {
              this.events.emit('tool:output', { toolUseId: tool.id, chunk });
            },
          });
          const elapsed = Date.now() - startTime;
          const records = sessionToolRecordsAtom.get();
          sessionToolRecordsAtom.set([...records, { toolName: tool.name, toolInput: tool.input, elapsedMs: elapsed }]);
          return { tool, result, elapsed };
        }),
      );

      clearInterval(timer);

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
          elapsedMs: item.status === 'fulfilled' ? item.value.elapsed : undefined,
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
      this.events.emit('status', { type: 'idle' });
    } else {
      this.events.emit('status', { type: 'idle' });
    }
    return { hasToolUse, wasTruncated, finalMessage };
  }

  private async coreRun(userInput: string, onIteration?: (result: IterationResult) => void) {
    this._aborted = false;
    appendSystemLog('Agent run 开始');
    sessionToolRecordsAtom.set([]);
    await clearBackups();
    const userContent = parseImageRefs(userInput);
    const updated = [...messagesAtom.get(), { role: 'user', content: userContent } as Anthropic.MessageParam];
    messagesAtom.set(updated);
    while (true) {
      if (this._aborted) {
        appendSystemLog('Agent run 被用户中断');
        this.events.emit('status', { type: 'idle' });
        return;
      }
      try {
        const result = await this.executeSingleIteration();
        onIteration?.(result);
        if (!result.hasToolUse && !result.wasTruncated) {
          if (!hasTextContent(result.finalMessage)) {
            appendSystemLog('Agent run 继续（响应仅含思考块，等待模型输出文本）');
            continue;
          }
          appendSystemLog('Agent run 结束（无待执行工具）');
          return;
        }
        appendSystemLog(`继续下一轮迭代（${result.wasTruncated ? '响应被截断' : '存在工具调用'}）`);
      } catch (err) {
        if (err instanceof Error && err.message === 'ABORT') {
          appendSystemLog('Agent run 被用户中断');
          this.events.emit('status', { type: 'idle' });
          return;
        }
        throw err;
      }
    }
  }

  async run(userInput: string, onIteration?: (result: IterationResult) => void) {
    const coreRunFn: RunFn = this.coreRun.bind(this);
    const chain = this.middlewares.reduceRight<RunFn>(
      (next, mw) => (input, cb) => mw(input, next, cb),
      coreRunFn,
    );
    return chain(userInput, onIteration);
  }
}

export const agentTurn = new AgentTurn();
