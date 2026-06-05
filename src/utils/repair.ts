import type { ConversationMessage } from '../store/conversation.js';
import { appendSystemLog } from '../store/logAtom.js';

function getToolUseIds(msg: ConversationMessage): string[] {
  if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return [];
  return msg.content.filter((b: any) => b.type === 'tool_use').map((b: any) => b.id);
}

function getToolResultIds(msg: ConversationMessage): string[] {
  if (msg.role !== 'user' || !Array.isArray(msg.content)) return [];
  return msg.content.filter((b: any) => b.type === 'tool_result').map((b: any) => b.tool_use_id);
}

// 从前往后校验 tool_use/tool_result 配对，截断到最后一个完整 pair
export function repairSessionMessages(messages: ConversationMessage[]): {
  cleaned: ConversationMessage[];
  truncated: number;
} {
  if (messages.length === 0) return { cleaned: [], truncated: 0 };

  const cleaned: ConversationMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
      cleaned.push(msg);
      continue;
    }

    const toolUseIds = getToolUseIds(msg);
    if (toolUseIds.length === 0) {
      cleaned.push(msg);
      continue;
    }

    const nextMsg = messages[i + 1];
    if (!nextMsg || nextMsg.role !== 'user' || !Array.isArray(nextMsg.content)) {
      break;
    }

    const resultIds = new Set(getToolResultIds(nextMsg));
    if (!toolUseIds.every((id) => resultIds.has(id))) {
      break;
    }

    cleaned.push(msg);
  }

  const truncated = messages.length - cleaned.length;
  if (truncated > 0) {
    appendSystemLog(`repairSessionMessages: 截断了 ${truncated} 条不完整的消息`);
  }
  return { cleaned, truncated };
}
