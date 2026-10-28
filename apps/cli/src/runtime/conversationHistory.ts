/**
 * 会话历史的纯函数工具：从消息数组里挑出用户消息、按文本定位某一条、算出截断点。
 *
 * 两个调用方共用这套判断：
 * - `RewindCheckpointManager`（`/rewind`）：把 provider history 切成一轮轮回退点；
 * - `mica app-server` 的 `mica/turn/editMessage`（desktop 双击编辑重发）：定位被
 *   编辑的用户消息，截掉它及其之后的内容，再用新文本重跑。
 *
 * 另有一个共用的判断是「turn 里哪些流式文本还没进历史」
 * （`uncommittedResponseText`）：中止一个 turn 时要把没提交的那段回答补进
 * provider history，两个 runtime（`LocalRuntimeController` 与
 * `HeadlessTurnExecutor`）必须用同一套口径，否则有一边会把已经落盘的文本再写一遍。
 *
 * 持久化的会话文件没有逐条消息 id，历史里的用户消息与 UI 展示文本也不完全同源，
 * 所以定位只能按「空白折叠后的文本相等」来做——两处调用方必须用同一个归一化，
 * 否则 desktop 里的第 N 条同文本消息会在 CLI 端错位。
 */
import { micaContext } from '@packages/mica-context/index.js';
import { comparableContentText, comparableMessageText, comparableText } from '@packages/mica-common/promptText.js';
import type { AgentRuntimeSnapshot } from '../agent/AgentRuntime.js';

export type ConversationMessage = Record<string, unknown>;

export { comparableContentText, comparableMessageText, comparableText };

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
 * 本 turn 里**还没进 provider history** 的那段流式文本。
 *
 * 运行中的文本缓冲（`onText` 累积）包含已经在工具迭代边界提交过的部分；中止时
 * 只应把余下的增量补进历史，整段补会与已提交的内容重复（history 里同一条回答出现两次）。
 * 前缀不匹配时退回整段（保守：宁可多写也不丢），committed 为空时同理。
 */
export function uncommittedResponseText(responseText: string, committedResponseText: string): string {
  if (!committedResponseText) return responseText;
  if (responseText.startsWith(committedResponseText)) {
    return responseText.slice(committedResponseText.length);
  }
  return responseText;
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
 *
 * `occurrenceFromEnd` 由客户端数出来（桌面端在整个 transcript 上数），而这里只在
 * provider history 里数，两边可能差一条（turn 启动时写进 conversationMessages、
 * 却没进 provider history 的那条用户消息）。所以只有一条匹配时把它当作目标——
 * 那一定是它，不存在改错人的风险；多条匹配时仍严格按计数，避免截错轮次。
 */
export function findUserMessageCutIndex(messages: unknown[], prompt: string, occurrenceFromEnd = 1): number {
  const target = comparableText(prompt);
  if (!target) return -1;
  const occurrence = Number.isInteger(occurrenceFromEnd) && occurrenceFromEnd > 0 ? occurrenceFromEnd : 1;
  const indexes = userMessageIndexes(messages);
  const matches: number[] = [];
  for (let cursor = indexes.length - 1; cursor >= 0; cursor--) {
    const index = indexes[cursor]!;
    if (comparableMessageText(messages[index]) !== target) continue;
    matches.push(index);
    if (matches.length === occurrence) return index;
  }
  return matches.length === 1 ? matches[0]! : -1;
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
    return { ok: false, message: describeLocateFailure(snapshot.messages, options.prompt) };
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

/**
 * 定位失败时按「用户能据此做什么」分档：纯媒体消息没有可比文本、同文本消息存在
 * 但条数对不上（历史被压缩或另一个窗口改写过）、以及彻底找不到。不要一律回
 * 「历史可能已经变化」——那让用户无法判断该刷新还是该改写。
 */
function describeLocateFailure(messages: unknown[], prompt: string): string {
  if (!comparableText(prompt)) {
    return '这条消息只有图片、没有可定位的文本，无法编辑重发';
  }
  if (findUserMessageCutIndex(messages, prompt) >= 0) {
    return '这条消息在会话里的位置已变化（可能被压缩或由另一个窗口改写），请重新打开会话后重试';
  }
  return '找不到这条消息：它可能没有真正发出，或者历史已被压缩';
}
