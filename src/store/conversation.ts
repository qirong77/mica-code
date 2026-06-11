import type Anthropic from '@anthropic-ai/sdk'
import { atom } from 'nanostores'
import { getContextUsage, getSingleRequestTotalTokens } from '../utils/getContextUsage.js'

export type ConversationMessage =
  | Anthropic.Message
  | { role: 'user'; content: Anthropic.MessageParam['content'] }

export const messagesAtom = atom<ConversationMessage[]>([])

export function isAssistantMessage(m: ConversationMessage): m is Anthropic.Message {
  return m.role === 'assistant'
}

export function toMessageParams(messages: ConversationMessage[]): Anthropic.MessageParam[] {
  return messages.map(({ role, content }) => ({ role, content })) as Anthropic.MessageParam[]
}

export function estimateContextSize(messages: ConversationMessage[]): number {
  return getContextUsage(messages)
}

export function updateContextSize(messages: ConversationMessage[]): number {
  const last = [...messages].reverse().find((m) => isAssistantMessage(m) && m.usage)
  if (!last || !isAssistantMessage(last)) return 0
  return getSingleRequestTotalTokens(last.usage)
}

export const contextSizeAtom = atom<number>(0)

function calcCacheHitRate(usage: Anthropic.Usage): number {
  const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
  if (input === 0) return 0
  return (usage.cache_read_input_tokens ?? 0) / input
}

export function updateCacheUsage(messages: ConversationMessage[]): void {
  const last = [...messages].reverse().find((m) => isAssistantMessage(m) && m.usage)
  if (!last || !isAssistantMessage(last) || !last.usage) {
    cacheHitRateAtom.set(0)
    return
  }
  cacheHitRateAtom.set(calcCacheHitRate(last.usage))
}

export const cacheHitRateAtom = atom<number>(0)
