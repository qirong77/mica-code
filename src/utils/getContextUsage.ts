import { isAssistantMessage, type ConversationMessage } from '../store/conversation.js'
import type { Usage } from '../types.js'

export function getSingleRequestTotalTokens(usage: Usage): number {
  return usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
}

// 当前上下文占用的 token 估算值，取最近一条 assistant 消息的 usage
// 与 getTotalBilledTokens 不同，不会跨多轮累加
export function getContextUsage(conversationList: ConversationMessage[]): number {
  const lastMsgWithUsage = [...conversationList].reverse().find(
    (m) => isAssistantMessage(m) && m.usage != null,
  )
  if (!lastMsgWithUsage || !isAssistantMessage(lastMsgWithUsage) || !lastMsgWithUsage.usage) {
    return 0
  }
  return getSingleRequestTotalTokens(lastMsgWithUsage.usage)
}

// 所有 API 调用的累计 token 消耗，会跨多轮累加
// 不适合用于估算当前上下文占用，用 getContextUsage 代替
export function getTotalBilledTokens(conversationList: ConversationMessage[]): number {
  let totalCost = 0
  for (const msg of conversationList) {
    if (isAssistantMessage(msg) && msg.usage) {
      totalCost += getSingleRequestTotalTokens(msg.usage)
    }
  }
  return totalCost
}
