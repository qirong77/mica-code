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
const SUMMARY_MAX_TOKENS = 8192;

export class AutoCompactPlugin extends MicaPlugin {
  private lastUserMessageTime = Date.now();
  private isCompressing = false;

  onInstall(): void {
    this.agent.agentTurn.use(async (userInput, next, onIteration) => {
      const now = Date.now();
      const timeSinceLastUser = now - this.lastUserMessageTime;
      this.lastUserMessageTime = now;

      if (this.isCompressing) return next(userInput, onIteration);

      const session = this.agent.agentTurn.session;
      const messages = session.getMessages();
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

        const summaryMessage =
          `以下是之前对话的详细摘要，对话因上下文超限被压缩。请基于此摘要和后续保留的消息继续工作，不要询问摘要中已涵盖的问题。\n\n${summary}`;

        const compacted: ConversationMessage[] = [
          { role: 'user', content: summaryMessage },
          ...toKeep,
        ];

        session.replaceMessages(compacted);
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

    const compactPrompt = `CRITICAL: 只输出纯文本，不要调用任何工具。

你的任务是创建一份详细的对话历史摘要。请先用 <analysis> 标签组织思路，确保覆盖了所有必要的信息点，然后用 <summary> 标签输出最终摘要。

分析时请按时间顺序检查每条消息，识别：用户的明确请求和意图、你的处理方式、关键决策、技术概念、具体文件名和代码、遇到的错误及修复方式、用户的具体反馈。

摘要应包含以下结构：

1. 主要请求与意图：详细描述用户所有的明确请求和意图
2. 关键技术概念：列出讨论过的重要技术概念、框架、库
3. 文件与代码：逐个列出查看、修改或创建的文件，包含完整代码片段和每个文件的重要性说明
4. 错误与修复：列出所有遇到的错误以及如何修复，特别关注用户给出的具体反馈
5. 问题解决：记录已解决的问题和仍在排查中的问题
6. 所有用户消息：列出全部非工具返回的用户消息
7. 待完成任务：列出用户明确要求完成但尚未完成的任务
8. 当前工作：精确描述摘要请求前正在进行的工作，包含文件名和代码片段
9. 可选的下一步：如有未完成的工作，列出下一步，包含对话原文引用

输出格式示例：
<analysis>
[你的分析过程，确保覆盖所有要点]
</analysis>

<summary>
1. 主要请求与意图：
   [详细描述]

2. 关键技术概念：
   - [概念 1]
   - [概念 2]

3. 文件与代码：
   - [文件名 1]
      - [该文件的重要性]
      - [代码片段]

4. 错误与修复：
   - [错误描述]
      - [修复方法]
      - [用户反馈]

5. 问题解决：
   [描述]

6. 所有用户消息：
   - [消息内容]

7. 待完成任务：
   - [任务描述]

8. 当前工作：
   [精确描述]

9. 可选的下一步：
   [下一步说明]
</summary>

请根据以上对话历史提供详细摘要，确保精确性和完整性。`;

    const response = await client.messages.create({
      model: modelName,
      max_tokens: SUMMARY_MAX_TOKENS,
      system: '你是一个擅长总结技术对话的助手。',
      messages: [
        ...messages,
        { role: 'user', content: compactPrompt },
      ],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const raw = textBlock?.text;
    if (!raw) return '[压缩失败]';

    return this.formatCompactSummary(raw);
  }

  private formatCompactSummary(raw: string): string {
    let result = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, '');

    const summaryMatch = result.match(/<summary>([\s\S]*?)<\/summary>/);
    if (summaryMatch?.[1]) {
      result = summaryMatch[1].trim();
    }

    return result.replace(/\n{3,}/g, '\n\n').trim();
  }
}
