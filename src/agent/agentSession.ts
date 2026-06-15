import type { Message, MessageParam, ToolResultBlockParam } from '@mica/llm';
import {
  messagesAtom,
  contextSizeAtom,
  updateContextSize,
  updateCacheUsage,
  type ConversationMessage,
} from '../store/conversation.js';
import {
  sessionToolRecordsAtom,
  type SessionToolRecord,
} from '../store/logAtom.js';
import { repairSessionMessages } from '../utils/repair.js';

const MAX_TOOL_RECORDS = 100;

export class AgentSession {
  appendUser(content: MessageParam['content']): void {
    messagesAtom.set([...messagesAtom.get(), { role: 'user', content }]);
  }

  appendAssistant(message: Message): void {
    const updated = [...messagesAtom.get(), message];
    messagesAtom.set(updated);
    contextSizeAtom.set(updateContextSize(updated));
    updateCacheUsage(updated);
  }

  appendToolResults(toolResults: ToolResultBlockParam[]): void {
    messagesAtom.set([
      ...messagesAtom.get(),
      { role: 'user', content: toolResults },
    ]);
  }

  getMessages(): ConversationMessage[] {
    return messagesAtom.get();
  }

  replaceMessages(messages: ConversationMessage[]): void {
    const { cleaned } = repairSessionMessages(messages);
    messagesAtom.set(cleaned);
    contextSizeAtom.set(updateContextSize(cleaned));
    updateCacheUsage(cleaned);
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
