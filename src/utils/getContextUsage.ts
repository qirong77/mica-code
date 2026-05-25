type ConversationMessage = {
  role: string;
  content: unknown;
  usage?: {
    input_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens: number;
  };
};

function getTokenCountFromUsage(
  usage: NonNullable<ConversationMessage["usage"]>
): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.output_tokens ?? 0)
  );
}

export function tokenCountFromConversation(
  conversationList: ConversationMessage[]
): number {
  let total = 0;
  for (const msg of conversationList) {
    if (msg.usage) {
      total += getTokenCountFromUsage(msg.usage);
    }
  }
  return total;
}

export function getContextUsage(
  conversationList: ConversationMessage[]
): number {
  const tokens = tokenCountFromConversation(conversationList);
  return tokens;
}
