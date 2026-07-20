import { micaContext } from '@packages/mica-context/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';

export function toCompactedConversationDisplay(messages: MicaUiConversationMessage[]): MicaUiConversationMessage[] {
  return messages.filter(
    (message) => !conversationContentToText(message.content).startsWith(micaContext.COMPACT_BOUNDARY_PREFIX),
  );
}

function conversationContentToText(content: MicaUiConversationMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}
