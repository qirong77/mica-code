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
