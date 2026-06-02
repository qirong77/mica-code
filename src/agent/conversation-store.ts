import type Anthropic from '@anthropic-ai/sdk';
import {
  messagesAtom,
  contextSizeAtom,
  updateContextSize,
  type ConversationMessage,
} from '../store/conversation.js';

export class ConversationStore {
  getMessages(): ConversationMessage[] {
    return messagesAtom.get();
  }

  appendUser(content: Anthropic.MessageParam['content']): void {
    const updated = [
      ...messagesAtom.get(),
      { role: 'user', content } as Anthropic.MessageParam,
    ];
    messagesAtom.set(updated);
  }

  appendAssistant(message: Anthropic.Message): void {
    const messages = messagesAtom.get();
    const updated = [...messages, message as unknown as ConversationMessage];
    messagesAtom.set(updated);
    contextSizeAtom.set(updateContextSize(updated));
  }

  appendToolResults(toolResults: Anthropic.ToolResultBlockParam[]): void {
    const updated = [
      ...messagesAtom.get(),
      { role: 'user', content: toolResults } as Anthropic.MessageParam,
    ];
    messagesAtom.set(updated);
  }
}
