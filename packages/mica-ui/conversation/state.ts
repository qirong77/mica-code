import { atom } from 'nanostores';
import { runtimeEnv } from '@packages/mica-config/runtimeEnv.js';
import type { MicaUiContentBlockParam, MicaUiMessageParam, MicaUiTextBlock } from '../types.js';

export type MicaUiPendingInputQueueMode = 'after_iteration' | 'after_turn';

export const messages = atom<MicaUiMessageParam[]>([]);
export const responseText = atom<string>('');
export const pendingInput = atom<string>('');
export const pendingInputs = atom<string[]>([]);
export const pendingQueueMode = atom<MicaUiPendingInputQueueMode | null>(null);
const MAX_UI_MESSAGE_TEXT_CHARS = runtimeEnv.ui.messageTextMaxChars;

export function setMessages(nextMessages: MicaUiMessageParam[]): void {
  messages.set(nextMessages.map(sanitizeMessageForUi));
}

export function appendMessage(message: MicaUiMessageParam): void {
  messages.set([...messages.get(), sanitizeMessageForUi(message)]);
}

export function appendUserMessage(content: MicaUiMessageParam['content']): void {
  appendMessage({ role: 'user', content });
}

export function appendAssistantMessage(content: MicaUiMessageParam['content']): void {
  appendMessage({ role: 'assistant', content });
}

export function appendNoticeMessage(
  content: MicaUiMessageParam['content'],
  options: Pick<MicaUiMessageParam, 'variant' | 'command'> = {},
): void {
  appendMessage({ role: 'notice', content, ...options });
}

export function clearMessages(): void {
  messages.set([]);
}

export function setResponseText(text: string): void {
  responseText.set(text);
}

export function clearResponseText(): void {
  responseText.set('');
}

export function setPendingInput(text: string, queueMode: MicaUiPendingInputQueueMode | null = null): void {
  pendingInput.set(text);
  pendingInputs.set(text ? [text] : []);
  pendingQueueMode.set(text ? queueMode : null);
}

export function clearPendingInput(): void {
  pendingInput.set('');
  pendingInputs.set([]);
  pendingQueueMode.set(null);
}

export function setPendingInputs(texts: string[], queueMode: MicaUiPendingInputQueueMode | null = null): void {
  const nextTexts = texts.slice(-1);
  pendingInputs.set(nextTexts);
  pendingInput.set(nextTexts.at(-1) ?? '');
  pendingQueueMode.set(nextTexts.length > 0 ? queueMode : null);
}

export function appendPendingInput(text: string): void {
  setPendingInputs([...pendingInputs.get(), text]);
}

function sanitizeMessageForUi(message: MicaUiMessageParam): MicaUiMessageParam {
  return {
    ...message,
    content: sanitizeContentForUi(message.content),
    ...(message.displayContent ? { displayContent: sanitizeContentForUi(message.displayContent) } : {}),
  };
}

function sanitizeContentForUi(content: MicaUiMessageParam['content']): MicaUiMessageParam['content'] {
  if (typeof content === 'string') return truncateMiddleText(content, MAX_UI_MESSAGE_TEXT_CHARS);

  const blocks: MicaUiContentBlockParam[] = [];
  let omittedImages = 0;
  for (const block of content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: truncateMiddleText(block.text, MAX_UI_MESSAGE_TEXT_CHARS) });
      continue;
    }
    omittedImages++;
  }

  if (omittedImages > 0 && blocks.length === 0) {
    blocks.push({ type: 'text', text: omittedImages === 1 ? '[Image]' : `[${omittedImages} images]` });
  }
  return blocks.length === 1 && blocks[0]!.type === 'text' ? (blocks[0] as MicaUiTextBlock).text : blocks;
}

function truncateMiddleText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `\n\n[message stored for UI truncated, omitted ${text.length - maxChars} chars]\n\n`;
  const budget = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(budget * 0.65);
  const tail = Math.floor(budget * 0.35);
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}
