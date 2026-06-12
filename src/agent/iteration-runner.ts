import Anthropic from '@anthropic-ai/sdk';
import { getSystemPrompt, getPlanModePrompt } from '../prompts/index';
import { getToolDefinitions } from '../tools/index';
import { EFFORT_TOKENS, model } from '../store/config.js';
import { appendSystemLog } from '../store/logAtom.js';
import { planModeAtom } from '../store/ui-state.js';
import { getClient } from './client.js';
import { AgentSession } from './agent-session.js';
import { ToolExecutor } from './tool-executor.js';
import { toMessageParams } from '../store/conversation.js';
import type { AgentTurnEmitter, CompletedToolUse, IterationResult } from './types.js';

let _iterationId = 0;

export type SystemPromptProvider = () => string;

export class IterationRunner {
  private getSystemPrompt: SystemPromptProvider;
  private getAnthropicClient: () => Anthropic;

  constructor(
    private session: AgentSession,
    private toolExecutor: ToolExecutor,
    private emit: AgentTurnEmitter['emit'],
    systemPromptProvider?: SystemPromptProvider,
    clientProvider?: () => Anthropic,
  ) {
    this.getSystemPrompt = systemPromptProvider ?? (() => {
      return planModeAtom.get() ? getPlanModePrompt() : getSystemPrompt();
    });
    this.getAnthropicClient = clientProvider ?? getClient;
  }

  async run(abortSignal: AbortSignal): Promise<IterationResult> {
    const iterationId = ++_iterationId;
    const messages = this.session.getMessages();
    const modelName = model.name.get();
    const effort = model.effort.get();

    appendSystemLog(`迭代 #${iterationId} 开始：model=${modelName} effort=${effort}`);
    this.emit('status', { type: 'connecting' });

    const stream = this.getAnthropicClient().messages.stream({
      model: modelName,
      max_tokens: model.maxTokens.get(),
      system: this.getSystemPrompt(),
      messages: toMessageParams(messages),
      thinking:
        effort === 'none'
          ? { type: 'disabled' as const }
          : { type: 'enabled' as const, budget_tokens: EFFORT_TOKENS[effort] },
      output_config: effort !== 'none' ? { effort } : undefined,
      tools: getToolDefinitions(),
    });

    abortSignal.addEventListener(
      'abort',
      () => {
        stream.controller.abort();
      },
      { once: true },
    );

    this.emit('stream:create', { stream, iterationId });

    let hasToolUse = false;
    const completedToolUses: CompletedToolUse[] = [];
    stream.on('contentBlock', (block: any) => {
      if (block.type === 'tool_use') {
        hasToolUse = true;
        const tool: CompletedToolUse = {
          id: block.id,
          name: block.name,
          input: block.input as Record<string, any>,
        };
        completedToolUses.push(tool);
        this.emit('tool:use', {
          toolUseId: tool.id,
          toolName: tool.name,
          toolInput: tool.input,
          completed: false,
          iterationId,
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
    this.session.appendAssistant(finalMessage);
    this.emit('message:final', { message: finalMessage, iterationId });
    appendSystemLog(
      `迭代 #${iterationId} 响应：${completedToolUses.length > 0 ? `${completedToolUses.length} 个工具调用` : '无工具调用'}${wasTruncated ? ' [因 max_tokens 截断]' : ''}`,
    );

    if (completedToolUses.length > 0) {
      const toolResults = await this.toolExecutor.execute(completedToolUses, abortSignal, iterationId);
      this.session.appendToolResults(toolResults);
    }

    this.emit('status', { type: 'idle' });
    return { hasToolUse, wasTruncated, finalMessage, iterationId };
  }
}
