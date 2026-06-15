import type { Message, MessageParam } from '../types.js'
import { atom } from 'nanostores'
import { getContextUsage, getSingleRequestTotalTokens } from '../utils/getContextUsage.js'

export type ConversationMessage =
  | Message
  | { role: 'user'; content: MessageParam['content'] }

export const messagesAtom = atom<ConversationMessage[]>([])

export function isAssistantMessage(m: ConversationMessage): m is Message {
  return m.role === 'assistant'
}

export function toMessageParams(messages: ConversationMessage[]): MessageParam[] {
  return messages.map(({ role, content }) => ({ role, content })) as MessageParam[]
}

export function estimateContextSize(messages: ConversationMessage[]): number {
  return getContextUsage(messages)
}

export function updateContextSize(messages: ConversationMessage[]): number {
  const last = [...messages].reverse().find((m) => isAssistantMessage(m) && m.usage)
  if (!last || !isAssistantMessage(last)) return 0
  return getSingleRequestTotalTokens(last.usage!)
}

export const contextSizeAtom = atom<number>(0)

export function updateCacheUsage(): void {
  cacheHitRateAtom.set(0)
}

export const cacheHitRateAtom = atom<number>(0)
