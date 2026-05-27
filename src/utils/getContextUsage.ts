import type { ConversationMessage } from '../store/conversation.js';

export function getSingleRequestTotalTokens(
  usage: NonNullable<ConversationMessage["usage"]>
): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.output_tokens ?? 0)
  );
}

/**
 * 用途一：计算【当前上下文窗口占用大小】 (用来判断是否快到 200K 限制)
 * 逻辑：只需要看最后一次带有 usage 的 AI 响应即可，因为它已经包含了前面的全部历史。
 */
export function getContextUsage(
  conversationList: ConversationMessage[]
): number {
  // 从后往前找，找到最新的一条带有 usage 记录的消息
  const lastMsgWithUsage = [...conversationList].reverse().find(msg => msg.usage);

  if (!lastMsgWithUsage || !lastMsgWithUsage.usage) {
    return 0;
  }
  
  return getSingleRequestTotalTokens(lastMsgWithUsage.usage);
}

/**
 * 用途二：计算【总计费消耗】 (用来算账/扣费)
 * 逻辑：每一轮 API 调用的开销都需要累加。
 */
export function getTotalBilledTokens(
  conversationList: ConversationMessage[]
): number {
  let totalCost = 0;
  for (const msg of conversationList) {
    if (msg.usage) {
      totalCost += getSingleRequestTotalTokens(msg.usage);
    }
  }
  return totalCost;
}