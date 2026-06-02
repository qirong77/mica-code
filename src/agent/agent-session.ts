import type Anthropic from '@anthropic-ai/sdk';
import {
  messagesAtom,
  contextSizeAtom,
  updateContextSize,
  type ConversationMessage,
} from '../store/conversation.js';
import {
  sessionToolRecordsAtom,
  type SessionToolRecord,
} from '../store/logAtom.js';

const MAX_TOOL_RECORDS = 100;

export class AgentSession {
  appendUser(content: Anthropic.MessageParam['content']): void {
    messagesAtom.set([...messagesAtom.get(), { role: 'user', content }]);
  }

  appendAssistant(message: Anthropic.Message): void {
    const updated = [...messagesAtom.get(), message];
    messagesAtom.set(updated);
    contextSizeAtom.set(updateContextSize(updated));
  }

  appendToolResults(toolResults: Anthropic.ToolResultBlockParam[]): void {
    messagesAtom.set([
      ...messagesAtom.get(),
      { role: 'user', content: toolResults },
    ]);
  }

  getMessages(): ConversationMessage[] {
    return messagesAtom.get();
  }

  replaceMessages(messages: ConversationMessage[]): void {
    messagesAtom.set(messages);
    contextSizeAtom.set(updateContextSize(messages));
  }

  addToolRecord(record: SessionToolRecord): void {
    const records = sessionToolRecordsAtom.get();
    const next = [...records, record];
    sessionToolRecordsAtom.set(
      next.length > MAX_TOOL_RECORDS ? next.slice(-MAX_TOOL_RECORDS) : next,
    );
  }

  clearToolRecords(): void {
    sessionToolRecordsAtom.set([]);
  }
}
