import Anthropic from '@anthropic-ai/sdk';
import { systemPrompt } from '../prompts/index';
import { getToolDefinitions } from '../tools/index';
import { EFFORT_TOKENS, model } from '../store/config.js';
import { appendSystemLog } from '../store/logAtom.js';
import { planModeAtom } from '../store/ui-state.js';
import { MessageStream } from '@anthropic-ai/sdk/lib/MessageStream.mjs';
import { getClient } from './client.js';
import { ConversationStore } from './conversation-store.js';
import { ToolExecutor } from './tool-executor.js';
import type { AgentTurnEmitter, CompletedToolUse, IterationResult } from './types.js';

export class IterationRunner {
  constructor(
    private conversation: ConversationStore,
    private toolExecutor: ToolExecutor,
    private emit: AgentTurnEmitter['emit'],
  ) {}

  async run(abortSignal: AbortSignal): Promise<IterationResult> {
    const messages = this.conversation.getMessages();
    const modelName = model.name.get();
    const effort = model.effort.get();

    appendSystemLog(`迭代开始：model=${modelName} effort=${effort}`);
    this.emit('status', { type: 'connecting' });

    const planReminder = planModeAtom.get()
      ? '\n\n<system-reminder>\n当前处于 plan mode，仅分析规划，不要执行代码修改等编辑操作。（除非用户明确提成执行你给出的规划，你才可以执行代码修改等编辑操作）\n</system-reminder>'
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
      tools: getToolDefinitions(),
    }) as MessageStream<null>;

    abortSignal.addEventListener(
      'abort',
      () => {
        stream.controller.abort();
      },
      { once: true },
    );

    this.emit('stream:create', stream);

    let hasToolUse = false;
    const completedToolUses: CompletedToolUse[] = [];
    stream.on('contentBlock', (content) => {
      if (content.type === 'tool_use') {
        hasToolUse = true;
        const tool: CompletedToolUse = {
          id: content.id,
          name: content.name,
          input: content.input as Record<string, any>,
        };
        completedToolUses.push(tool);
        this.emit('tool:use', {
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
    this.conversation.appendAssistant(finalMessage);
    this.emit('message:final', finalMessage);
    appendSystemLog(
      `迭代响应：${completedToolUses.length > 0 ? `${completedToolUses.length} 个工具调用` : '无工具调用'}${wasTruncated ? ' [因 max_tokens 截断]' : ''}`,
    );

    if (completedToolUses.length > 0) {
      const toolResults = await this.toolExecutor.execute(completedToolUses, abortSignal);
      this.conversation.appendToolResults(toolResults);
    }

    this.emit('status', { type: 'idle' });
    return { hasToolUse, wasTruncated, finalMessage };
  }
}
