import { atom } from 'nanostores';
import type { MicaUiMessageParam } from '../types.js';

export type MicaUiPendingInputQueueMode = 'after_iteration' | 'after_turn';

export const messages = atom<MicaUiMessageParam[]>([]);
export const responseText = atom<string>('');
export const pendingInput = atom<string>('');
export const pendingInputs = atom<string[]>([]);
export const pendingQueueMode = atom<MicaUiPendingInputQueueMode | null>(null);

export function setMessages(nextMessages: MicaUiMessageParam[]): void {
  messages.set(nextMessages);
}

export function appendMessage(message: MicaUiMessageParam): void {
  messages.set([...messages.get(), message]);
}

export function appendUserMessage(content: MicaUiMessageParam['content']): void {
  appendMessage({ role: 'user', content });
}

export function appendAssistantMessage(content: MicaUiMessageParam['content']): void {
  appendMessage({ role: 'assistant', content });
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
