import { atom } from 'nanostores';
import type Anthropic from '@anthropic-ai/sdk';
import { getContextUsage } from '../utils/getContextUsage.js';

export const messagesAtom = atom<Anthropic.MessageParam[]>([]);

export function estimateContextSize(messages: Anthropic.MessageParam[]): number {
  // @ts-ignore
  return getContextUsage(messages);
}
// 当前主流的模型（如 Claude 3.5/4 系列默认是 200K（20 万 Token）窗口；GPT-4o 是 128K Token；而 DeepSeek V4 和 Gemini 则是 1M/2M Token 级别）。
export const contextSizeAtom = atom<number>(0);
