export interface AgentTextBlock {
  type: 'text';
  text: string;
}

export interface AgentImageBlockParam {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
}

export type AgentContentBlockParam = AgentTextBlock | AgentImageBlockParam;

export type AgentQueryContent = string | AgentContentBlockParam[];

export type AgentConversationMessage =
  | {
      role: 'assistant';
      content: string | AgentContentBlockParam[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
    }
  | { role: 'user'; content: string | AgentContentBlockParam[] };

export type AgentContentPartMapper = (
  part: Record<string, unknown>,
) => AgentContentBlockParam | string | null | undefined;

export function providerContentToAgentContent(
  content: unknown,
  mapPart: AgentContentPartMapper,
): string | AgentContentBlockParam[] | null {
  if (!content) return null;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);

  const blocks: AgentContentBlockParam[] = [];
  const fallbackText: string[] = [];

  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const mapped = mapPart(part as Record<string, unknown>);
    if (!mapped) continue;
    if (typeof mapped === 'string') {
      fallbackText.push(mapped);
    } else {
      blocks.push(mapped);
    }
  }

  if (fallbackText.length > 0) {
    blocks.push({ type: 'text', text: fallbackText.join('\n') });
  }
  return blocks.length > 0 ? blocks : null;
}
