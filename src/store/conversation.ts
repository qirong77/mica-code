import { atom } from 'nanostores';
import { getContextUsage, getSingleRequestTotalTokens } from '../utils/getContextUsage.js';

export interface ConversationMessage {
  role: string;
  content: unknown;
  usage?: {
    input_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens: number;
  };
}

export const messagesAtom = atom<ConversationMessage[]>([]);

export function estimateContextSize(messages: ConversationMessage[]): number {
  return getContextUsage(messages);
}

export function updateContextSize(messages: ConversationMessage[]): number {
  const last = [...messages].reverse().find((m) => m.usage);
  if (!last?.usage) return 0;
  return getSingleRequestTotalTokens(last.usage);
}

export const contextSizeAtom = atom<number>(0);
