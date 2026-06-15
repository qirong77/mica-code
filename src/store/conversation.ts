import type { Message, MessageParam, Usage } from '@mica/llm'
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

export function updateCacheUsage(messages: ConversationMessage[]): void {
  const assistants = messages.filter((m) => isAssistantMessage(m) && m.usage) as (Message & { usage: NonNullable<Usage> })[]
  if (assistants.length === 0) {
    cacheHitRateAtom.set(0)
    return
  }

  let realConsumed = 0
  for (const m of assistants) {
    realConsumed += (m.usage.input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0)
  }

  const lastUsage = assistants[assistants.length - 1].usage!
  const totalInput = (lastUsage.input_tokens ?? 0) + (lastUsage.cache_creation_input_tokens ?? 0) + (lastUsage.cache_read_input_tokens ?? 0)

  if (totalInput === 0) {
    cacheHitRateAtom.set(0)
    return
  }

  cacheHitRateAtom.set(realConsumed / totalInput)
}

export const cacheHitRateAtom = atom<number>(0)
