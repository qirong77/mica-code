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
