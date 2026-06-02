import type Anthropic from '@anthropic-ai/sdk';
import { MicaPlugin } from '../MicaPlugin';
import { getContextUsage } from '../../utils/getContextUsage';
import { getClient } from '../../agent/client';
import { model } from '../../store/config.js';
import { toMessageParams, type ConversationMessage } from '../../store/conversation.js';

const CONTEXT_THRESHOLD = 0.4;
const INACTIVITY_THRESHOLD_MS = 45 * 60 * 1000;
const KEEP_RECENT_COUNT = 6;
const MIN_MESSAGES_TO_COMPACT = 8;
const SUMMARY_MAX_TOKENS = 2048;

export class AutoCompactPlugin extends MicaPlugin {
  private lastUserMessageTime = Date.now();
  private isCompressing = false;

  onInstall(): void {
    this.agent.agentTurn.use(async (userInput, next, onIteration) => {
      const now = Date.now();
      const timeSinceLastUser = now - this.lastUserMessageTime;
      this.lastUserMessageTime = now;

      if (this.isCompressing) return next(userInput, onIteration);

      const messages = this.atoms.messages.get();
      if (messages.length < MIN_MESSAGES_TO_COMPACT) {
        return next(userInput, onIteration);
      }

      const contextUsage = getContextUsage(messages);
      const maxContext = model.contextWindowSize.get();
      const contextRatio = maxContext > 0 ? contextUsage / maxContext : 0;

      const timeTriggered = timeSinceLastUser > INACTIVITY_THRESHOLD_MS;
      const contextTriggered = contextRatio > CONTEXT_THRESHOLD;

      if (!timeTriggered && !contextTriggered) {
        return next(userInput, onIteration);
      }

      this.isCompressing = true;

      const triggerReason = contextTriggered
        ? `上下文使用 ${(contextRatio * 100).toFixed(0)}%（阈值 40%）`
        : `超过 ${Math.floor(timeSinceLastUser / 60000)} 分钟无对话`;

      const msgId = this.showMessage(`${triggerReason}，正在压缩对话历史...`, 0);

      try {
        const toKeep = messages.slice(-KEEP_RECENT_COUNT);
        const toCompress = messages.slice(0, -KEEP_RECENT_COUNT);

        const summary = await this.summarizeMessages(toMessageParams(toCompress));

        const compacted: ConversationMessage[] = [
          { role: 'user', content: `[对话历史摘要]\n${summary}` },
          ...toKeep,
        ];

        this.atoms.messages.set(compacted);
        this.removeMessage(msgId);

        const newUsage = getContextUsage(compacted);
        const newRatio = maxContext > 0 ? (newUsage / maxContext * 100).toFixed(1) : '?';
        this.showMessage(
          `压缩完成：${toCompress.length} 条消息 → 1 条摘要，上下文使用 ${newRatio}%`,
          5000,
        );
      } catch {
        this.removeMessage(msgId);
        this.showMessage('压缩失败，继续正常对话', 3000);
      } finally {
        this.isCompressing = false;
      }

      return next(userInput, onIteration);
    });
  }

  private async summarizeMessages(messages: Anthropic.MessageParam[]): Promise<string> {
    const modelName = this.atoms.model.get();
    const client = getClient();

    const response = await client.messages.create({
      model: modelName,
      max_tokens: SUMMARY_MAX_TOKENS,
      system:
        '你是一个对话压缩助手。请将以下对话历史压缩为一段简洁的摘要，用中文回答。保留：用户的问题、关键回答、重要决策、未完成的任务。',
      messages: [
        ...messages,
        { role: 'user', content: '请将以上对话历史压缩为一段简洁的摘要。' },
      ],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    return textBlock?.text ?? '[压缩失败]';
  }
}
