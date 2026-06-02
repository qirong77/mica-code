import { isAssistantMessage, type ConversationMessage } from '../store/conversation.js'
import type Anthropic from '@anthropic-ai/sdk'

export function getSingleRequestTotalTokens(usage: Anthropic.Usage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.output_tokens ?? 0)
  )
}

export function getContextUsage(conversationList: ConversationMessage[]): number {
  const lastMsgWithUsage = [...conversationList].reverse().find(
    (m) => isAssistantMessage(m) && m.usage != null,
  )
  if (!lastMsgWithUsage || !isAssistantMessage(lastMsgWithUsage) || !lastMsgWithUsage.usage) {
    return 0
  }
  return getSingleRequestTotalTokens(lastMsgWithUsage.usage)
}

export function getTotalBilledTokens(conversationList: ConversationMessage[]): number {
  let totalCost = 0
  for (const msg of conversationList) {
    if (isAssistantMessage(msg) && msg.usage) {
      totalCost += getSingleRequestTotalTokens(msg.usage)
    }
  }
  return totalCost
}
