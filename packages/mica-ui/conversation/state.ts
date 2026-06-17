import { atom } from 'nanostores';
import type { MicaUiMessageParam } from '../types.js';

export const messages = atom<MicaUiMessageParam[]>([]);
export const responseText = atom<string>('');
export const pendingInput = atom<string>('');
export const pendingInputs = atom<string[]>([]);

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

export function setPendingInput(text: string): void {
  pendingInput.set(text);
  pendingInputs.set(text ? [text] : []);
}

export function clearPendingInput(): void {
  pendingInput.set('');
  pendingInputs.set([]);
}

export function setPendingInputs(texts: string[]): void {
  const nextTexts = [...texts];
  pendingInputs.set(nextTexts);
  pendingInput.set(nextTexts.at(-1) ?? '');
}

export function appendPendingInput(text: string): void {
  setPendingInputs([...pendingInputs.get(), text]);
}
