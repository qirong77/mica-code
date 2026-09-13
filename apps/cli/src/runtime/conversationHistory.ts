/**
 * 会话历史的纯函数工具：从消息数组里挑出用户消息、按文本定位某一条、算出截断点。
 *
 * 两个调用方共用这套判断：
 * - `RewindCheckpointManager`（`/rewind`）：把 provider history 切成一轮轮回退点；
 * - `mica app-server` 的 `mica/turn/editMessage`（desktop 双击编辑重发）：定位被
 *   编辑的用户消息，截掉它及其之后的内容，再用新文本重跑。
 *
 * 持久化的会话文件没有逐条消息 id，历史里的用户消息与 UI 展示文本也不完全同源，
 * 所以定位只能按「空白折叠后的文本相等」来做——两处调用方必须用同一个归一化，
 * 否则 desktop 里的第 N 条同文本消息会在 CLI 端错位。
 */
import { micaContext } from '@packages/mica-context/index.js';
import type { AgentRuntimeSnapshot } from '../agent/AgentRuntime.js';

export type ConversationMessage = Record<string, unknown>;

export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if ('text' in part && typeof part.text === 'string') return part.text;
      if ('type' in part && typeof part.type === 'string' && part.type.includes('image')) return '[Image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function messageText(message: unknown): string {
  if (!message || typeof message !== 'object' || !('content' in message)) return '';
  return contentText(message.content);
}

/** UI 层展示文本（`displayContent` 优先），插件注入消息靠它区分本体与展示。 */
export function displayMessageText(message: unknown): string {
  if (!message || typeof message !== 'object' || !('displayContent' in message)) return '';
  return contentText(message.displayContent);
}

/**
 * 定位用的归一化文本：折叠空白，避免换行/缩进差异导致匹配失败。图片占位符也
 * 统一成 provider 侧的写法——desktop 的历史投影产出「[图片]」，这里是「[Image]」，
 * 不统一就会让「编辑一条带图消息」永远定位失败。
 */
export function comparableText(text: unknown): string {
  return String(text ?? '')
    .replace(/\[图片\]/g, '[Image]')
    .replace(/\s+/g, ' ')
    .trim();
}

export function comparableMessageText(message: unknown): string {
  return comparableText(messageText(message));
}

/**
 * 消息数组里「真实用户输入」的下标：compact 边界与摘要也是 user role，
 * 但不是用户键入的内容，必须排除，否则回退点/截断点会落在压缩元数据上。
 */
export function userMessageIndexes(messages: unknown[]): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || !('role' in message) || message.role !== 'user') continue;
    const text = comparableMessageText(message);
    if (text.startsWith(micaContext.COMPACT_BOUNDARY_PREFIX) || text.startsWith(micaContext.COMPACT_SUMMARY_PREFIX)) {
      continue;
    }
    indexes.push(index);
  }
  return indexes;
}

/**
 * 用量记录与消息下标对齐：chat completions 的一条 usage 覆盖「含本条消息」的
 * 请求，responses 覆盖「本条消息之前」的请求，所以要分协议调整边界。
 */
export function usageBeforeMessage(
  protocol: AgentRuntimeSnapshot['protocol'],
  usageHistory: AgentRuntimeSnapshot['usageHistory'],
  messageIndex: number,
): AgentRuntimeSnapshot['usageHistory'] {
  const messageCountLimit = protocol === 'openai_chat_completions' ? messageIndex + 1 : messageIndex;
  return usageHistory.filter((usage) => usage.messageCount <= messageCountLimit);
}

/**
 * 从末尾数第 `occurrenceFromEnd` 条文本匹配的用户消息下标；找不到返回 -1。
 */
export function findUserMessageCutIndex(
  messages: unknown[],
  prompt: string,
  occurrenceFromEnd = 1,
): number {
  const target = comparableText(prompt);
  if (!target) return -1;
  const occurrence =
    Number.isInteger(occurrenceFromEnd) && occurrenceFromEnd > 0 ? occurrenceFromEnd : 1;
  const indexes = userMessageIndexes(messages);
  let seen = 0;
  for (let cursor = indexes.length - 1; cursor >= 0; cursor--) {
    const index = indexes[cursor]!;
    if (comparableMessageText(messages[index]) !== target) continue;
    seen += 1;
    if (seen === occurrence) return index;
  }
  return -1;
}

export type TruncatedHistory = {
  messages: unknown[];
  usageHistory: AgentRuntimeSnapshot['usageHistory'];
  lastUsage: AgentRuntimeSnapshot['usageHistory'][number] | undefined;
};

export type TruncateHistoryResult =
  | { ok: true; snapshot: TruncatedHistory; removedMessages: number }
  | { ok: false; message: string };

/**
 * 截掉指定用户消息及其之后的一切（对话内容与用量），返回可直接写回
 * `agent.loadSnapshot` 的字段。provider history 是唯一事实来源：UI 的
 * conversationMessages 由 client 从 provider messages 派生
 * （`toConversationMessages`），loadSnapshot 会一并重建，所以这里不动 UI 层。
 */
export function truncateHistoryBeforeUserMessage(
  snapshot: Pick<AgentRuntimeSnapshot, 'messages' | 'usageHistory' | 'protocol'>,
  options: { prompt: string; occurrenceFromEnd?: number },
): TruncateHistoryResult {
  const cutIndex = findUserMessageCutIndex(snapshot.messages, options.prompt, options.occurrenceFromEnd);
  if (cutIndex < 0) {
    return { ok: false, message: '找不到要编辑的消息，历史可能已经变化' };
  }
  const usageHistory = usageBeforeMessage(snapshot.protocol, snapshot.usageHistory, cutIndex);
  return {
    ok: true,
    removedMessages: snapshot.messages.length - cutIndex,
    snapshot: {
      messages: snapshot.messages.slice(0, cutIndex),
      usageHistory,
      lastUsage: usageHistory.at(-1),
    },
  };
}
