import type Anthropic from '@anthropic-ai/sdk';
import { createSubAgent } from '../agent/subagent.js';
import { toMessageParams, type ConversationMessage } from '../store/conversation.js';
import { readSessionMemory } from '../plugins/memory/memoryPaths.js';

const COMPACT_PROMPT = `CRITICAL: 只输出纯文本，不要调用任何工具。

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

export const KEEP_RECENT_COUNT = 6;
export const MIN_MESSAGES_TO_COMPACT = 8;

function formatCompactSummary(raw: string): string {
  let result = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, '');

  const summaryMatch = result.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch?.[1]) {
    result = summaryMatch[1].trim();
  }

  return result.replace(/\n{3,}/g, '\n\n').trim();
}

// 调用大模型对指定消息列表做摘要
const summarizeSubAgent = createSubAgent({
  systemPrompt: '你是一个擅长总结技术对话的助手。',
  maxTokens: 8192,
});

export async function summarizeMessages(messages: Anthropic.MessageParam[]): Promise<string> {
  const result = await summarizeSubAgent([
    ...messages,
    { role: 'user', content: COMPACT_PROMPT },
  ]);

  if (!result.text) return '[压缩失败]';
  return formatCompactSummary(result.text);
}

// 压缩整段对话：旧消息 → 摘要，保留最近 N 条
export async function compactMessages(
  messages: ConversationMessage[],
): Promise<{ compacted: ConversationMessage[]; toCompressCount: number }> {
  const toKeep = messages.slice(-KEEP_RECENT_COUNT);
  const toCompress = messages.slice(0, -KEEP_RECENT_COUNT);

  const summary = await summarizeMessages(toMessageParams(toCompress));

  const summaryMessage =
    `以下是之前对话的详细摘要，对话因上下文超限被压缩。请基于此摘要和后续保留的消息继续工作，不要询问摘要中已涵盖的问题。\n\n${summary}`;

  const compacted: ConversationMessage[] = [
    { role: 'user', content: summaryMessage },
    ...toKeep,
  ];

  return { compacted, toCompressCount: toCompress.length };
}

// 尝试使用会话记忆进行压缩，替代模型摘要
export async function trySessionMemoryCompact(
  sessionId: string,
  messages: ConversationMessage[],
): Promise<ConversationMessage[] | null> {
  const sessionMemory = readSessionMemory(sessionId);
  if (!sessionMemory || !sessionMemory.trim()) return null;

  const toKeep = messages.slice(-KEEP_RECENT_COUNT);

  const summaryMessage =
    `以下是之前对话的会话记忆摘要，对话因上下文超限被压缩。请基于此摘要和后续保留的消息继续工作，不要询问摘要中已涵盖的问题。\n\n${sessionMemory}`;

  const compacted: ConversationMessage[] = [
    { role: 'user', content: summaryMessage },
    ...toKeep,
  ];

  return compacted;
}
