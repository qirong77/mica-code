import type {
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from 'openai/resources/chat/completions';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlockParam {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ToolResultBlockParam {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type UserContentBlock = TextBlock | ImageBlockParam | ToolResultBlockParam;
export type AssistantContentBlock = TextBlock | ToolUseBlock;
export type ContentBlockParam = UserContentBlock;

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | Array<UserContentBlock | AssistantContentBlock>;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface Message {
  role: 'assistant';
  content: AssistantContentBlock[];
  usage?: Usage;
  stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}

export type {
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
};

export interface MessageCreateParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: MessageParam[];
  tools?: Tool[];
  thinking?: { type: 'disabled' } | { type: 'enabled'; budget_tokens?: number };
  output_config?: { effort: string };
}

export type StreamEventMap = {
  text: (chunk: string) => void;
  thinking: (chunk: string) => void;
  contentBlock: (block: AssistantContentBlock) => void;
};

export interface MessageStream {
  on<K extends keyof StreamEventMap>(event: K, handler: StreamEventMap[K]): void;
  finalMessage(): Promise<Message>;
  controller: { abort(): void };
}

export interface LlmClient {
  messages: {
    create(params: MessageCreateParams): Promise<Message>;
    stream(params: MessageCreateParams): MessageStream;
  };
  isRetryableError(error: unknown): boolean;
}

export interface LlmClientConfig {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
}
