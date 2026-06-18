import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  ContentBlockParam,
  MessageDeltaUsage,
  MessageParam,
  RawMessageStreamEvent,
  Tool,
  ToolUseBlock,
  Usage,
} from '@anthropic-ai/sdk/resources/messages';
import { executeTool, getToolDefinitions } from '../../tools';
import {
  BaseAgent,
  type AgentQueryContent,
  type AgentQueryOptions,
  type AgentSnapshot,
  type AgentUsageRecord,
} from '../core/Agent';
import type { MicaUiConversationMessage, MicaUiContentBlockParam } from '../../mica-ui/types';
import { buildSystemPrompt } from '../prompt';

export type AnthropicAgentOptions = {
  model: string;
  apiKey?: string;
  baseURL?: string;
  maxTokens?: number;
  effort?: 'none' | 'low' | 'medium' | 'high';
  tools?: boolean;
  systemPrompt?: string;
};

type AnthropicMergedUsage = {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  rawEvents: {
    messageStart?: Usage;
    messageDeltas: MessageDeltaUsage[];
  };
};

export type AnthropicUsageRecord = AgentUsageRecord & {
  provider: 'anthropic';
  rawUsage: AnthropicMergedUsage;
};

type AnthropicToolUse = Pick<ToolUseBlock, 'id' | 'name' | 'input' | 'type'>;

const DEFAULT_MAX_TOKENS = 4096;
const THINKING_BUDGET_TOKENS: Record<Exclude<AnthropicAgentOptions['effort'], undefined | 'none'>, number> = {
  low: 1024,
  medium: 4096,
  high: 8192,
};

function abortError(): Error {
  const error = new Error('Agent query aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfQueryStopped(options?: AgentQueryOptions): void {
  if (options?.signal?.aborted || options?.shouldContinue?.() === false) {
    throw abortError();
  }
}

function getClient(options: AnthropicAgentOptions) {
  return new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });
}

export class AnthropicAgent extends BaseAgent<AnthropicAgentOptions, MessageParam, AnthropicUsageRecord> {
  messages: MessageParam[] = [];
  usageHistory: AnthropicUsageRecord[] = [];
  lastUsage: AnthropicUsageRecord | undefined;
  private turnId = 0;
  model: string;
  apiKey: string | undefined;
  baseURL: string | undefined;
  maxTokens: number;
  effort: AnthropicAgentOptions['effort'];
  tools: boolean;
  systemPrompt: string | undefined;

  constructor(options: string | AnthropicAgentOptions) {
    super();
    this.tools = true;
    this.maxTokens = DEFAULT_MAX_TOKENS;
    if (typeof options === 'string') {
      this.model = options;
      this.apiKey = process.env.ANTHROPIC_API_KEY;
      this.effort = 'none';
      return;
    }
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.effort = options.effort ?? 'none';
    this.tools = options.tools ?? true;
    this.systemPrompt = options.systemPrompt;
  }

  configure(options: AnthropicAgentOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.effort = options.effort ?? 'none';
    this.tools = options.tools ?? true;
    this.systemPrompt = options.systemPrompt;
  }

  reset() {
    this.messages = [];
    this.usageHistory = [];
    this.lastUsage = undefined;
    this.turnId = 0;
  }

  loadSnapshot(snapshot: AgentSnapshot<MessageParam, AnthropicUsageRecord>) {
    this.messages = snapshot.messages.filter((message) => message.role !== 'system');
    this.usageHistory = snapshot.usageHistory;
    this.lastUsage = snapshot.lastUsage;
    this.turnId = this.usageHistory.reduce((max, usage) => Math.max(max, usage.turnId), 0);
  }

  toConversationMessages(): MicaUiConversationMessage[] {
    return this.messages.flatMap((message) => {
      if (message.role !== 'user' && message.role !== 'assistant') return [];
      const content = anthropicContentToMicaContent(message.content);
      if (!content) return [];
      return [{ role: message.role, content }];
    });
  }

  private get anthropicTools(): Tool[] {
    return getToolDefinitions().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Tool.InputSchema,
    }));
  }

  async query(question: AgentQueryContent, options?: AgentQueryOptions): Promise<string> {
    const turnId = ++this.turnId;
    let requestIndex = 0;
    const messages: MessageParam[] = [
      ...this.messages,
      { role: 'user', content: micaContentToAnthropicContent(question) },
    ];

    while (true) {
      throwIfQueryStopped(options);
      requestIndex++;
      const stream = await getClient(this).messages.create(
        {
          model: this.model,
          system: this.systemPrompt ?? buildSystemPrompt(),
          max_tokens: this.maxTokens,
          messages,
          ...(this.tools
            ? {
                tools: this.anthropicTools,
                tool_choice: { type: 'auto' as const },
              }
            : {}),
          ...(this.thinkingConfig ? { thinking: this.thinkingConfig } : {}),
          stream: true,
        },
        { signal: options?.signal },
      );

      let content = '';
      const contentBlocks = new Map<number, ContentBlock>();
      const toolInputJson = new Map<number, string>();
      const usageMetadata = {
        model: this.model,
        turnId,
        requestIndex,
        messageCount: messages.length,
      };
      const usageAccumulator = createUsageAccumulator();

      for await (const event of stream) {
        throwIfQueryStopped(options);
        collectUsageEvent(usageAccumulator, event);

        if (event.type === 'content_block_start') {
          contentBlocks.set(event.index, event.content_block);
          if (event.content_block.type === 'tool_use') {
            toolInputJson.set(event.index, '');
          }
          continue;
        }

        if (event.type !== 'content_block_delta') continue;
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          content += delta.text;
          this.onText?.(delta.text);
        } else if (delta.type === 'thinking_delta') {
          this.onThinking?.(delta.thinking);
        } else if (delta.type === 'input_json_delta') {
          toolInputJson.set(event.index, `${toolInputJson.get(event.index) ?? ''}${delta.partial_json}`);
        }
      }
      this.recordUsage(usageAccumulator, usageMetadata);

      const toolUses = Array.from(contentBlocks.entries())
        .filter((entry): entry is [number, ToolUseBlock] => entry[1].type === 'tool_use')
        .map(([index, block]) => ({
          id: block.id,
          name: block.name,
          type: block.type,
          input: parseToolInput(toolInputJson.get(index), block.input),
        }));

      const assistantMessage: MessageParam = {
        role: 'assistant',
        content: buildAssistantContent(content, toolUses),
      };
      messages.push(assistantMessage);

      if (toolUses.length === 0) {
        this.messages = messages;
        return content;
      }

      const toolResults: ContentBlockParam[] = [];
      for (const toolUse of toolUses) {
        throwIfQueryStopped(options);
        const args = JSON.stringify(toolUse.input ?? {});
        this.onToolCall?.(toolUse.name, args, toolUse.id);
        let result: string;
        let isError = false;
        try {
          result = await executeTool(toolUse.name, toolUse.input ?? {}, {
            signal: options?.signal,
          });
        } catch (error) {
          isError = true;
          result = `工具执行失败: ${error instanceof Error ? error.message : String(error)}`;
        }
        throwIfQueryStopped(options);
        this.onToolResult?.(toolUse.name, result, toolUse.id);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
          is_error: isError,
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }
  }

  private get thinkingConfig() {
    if (!this.effort || this.effort === 'none') return undefined;
    const budget_tokens = Math.min(THINKING_BUDGET_TOKENS[this.effort], Math.max(1024, this.maxTokens - 1));
    if (budget_tokens >= this.maxTokens) return undefined;
    return { type: 'enabled' as const, budget_tokens };
  }

  private recordUsage(
    usage: AnthropicMergedUsage,
    metadata: {
      model: string;
      turnId: number;
      requestIndex: number;
      messageCount: number;
    },
  ) {
    const inputTokens = usage.input_tokens;
    const cacheWriteInputTokens = usage.cache_creation_input_tokens;
    const cachedInputTokens = usage.cache_read_input_tokens;
    const effectiveInputTokens = inputTokens + cacheWriteInputTokens + cachedInputTokens;
    const outputTokens = usage.output_tokens;
    const totalTokens = effectiveInputTokens + outputTokens;
    const paidTokenRate = totalTokens > 0 ? Math.max(0, totalTokens - cachedInputTokens) / totalTokens : 0;

    const record: AnthropicUsageRecord = {
      provider: 'anthropic',
      turnId: metadata.turnId,
      requestIndex: metadata.requestIndex,
      messageCount: metadata.messageCount,
      model: metadata.model,
      inputTokens: effectiveInputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens,
      paidTokenRate,
      rawUsage: usage,
    };

    this.lastUsage = record;
    this.usageHistory.push(record);
    this.onUsage?.(record);
  }
}

export function createAnthropicSubAgent(options: AnthropicAgentOptions): AnthropicAgent {
  return new AnthropicAgent({
    ...options,
    effort: 'none',
    tools: false,
  });
}

function createUsageAccumulator(): AnthropicMergedUsage {
  return {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    rawEvents: {
      messageDeltas: [],
    },
  };
}

function collectUsageEvent(accumulator: AnthropicMergedUsage, event: RawMessageStreamEvent): void {
  if (event.type === 'message_start') {
    accumulator.rawEvents.messageStart = event.message.usage;
    mergeAnthropicUsage(accumulator, event.message.usage);
    return;
  }

  if (event.type === 'message_delta') {
    accumulator.rawEvents.messageDeltas.push(event.usage);
    mergeAnthropicUsage(accumulator, event.usage);
  }
}

function mergeAnthropicUsage(accumulator: AnthropicMergedUsage, usage: Usage | MessageDeltaUsage): void {
  accumulator.input_tokens = Math.max(accumulator.input_tokens, usage.input_tokens ?? 0);
  accumulator.cache_creation_input_tokens = Math.max(
    accumulator.cache_creation_input_tokens,
    usage.cache_creation_input_tokens ?? 0,
  );
  accumulator.cache_read_input_tokens = Math.max(
    accumulator.cache_read_input_tokens,
    usage.cache_read_input_tokens ?? 0,
  );
  accumulator.output_tokens = Math.max(accumulator.output_tokens, usage.output_tokens ?? 0);
}

function micaContentToAnthropicContent(content: AgentQueryContent): MessageParam['content'] {
  if (typeof content === 'string') return content;

  return content.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }

    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: part.source.media_type,
        data: part.source.data,
      },
    };
  });
}

function buildAssistantContent(text: string, toolUses: AnthropicToolUse[]): MessageParam['content'] {
  const blocks: ContentBlockParam[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const toolUse of toolUses) {
    blocks.push({
      type: 'tool_use',
      id: toolUse.id,
      name: toolUse.name,
      input: toolUse.input,
    });
  }
  return blocks.length > 0 ? blocks : '';
}

function parseToolInput(inputJson: string | undefined, fallback: unknown): unknown {
  if (!inputJson) return fallback;
  try {
    return JSON.parse(inputJson);
  } catch {
    return fallback;
  }
}

function anthropicContentToMicaContent(content: MessageParam['content']): string | MicaUiContentBlockParam[] | null {
  if (!content) return null;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);

  const blocks: MicaUiContentBlockParam[] = [];
  const fallbackText: string[] = [];

  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image') {
      fallbackText.push('[Image]');
      continue;
    }
    if (part.type === 'tool_use') {
      fallbackText.push(`[Tool: ${part.name}]`);
      continue;
    }
    if (part.type === 'tool_result') {
      fallbackText.push('[Tool result]');
      continue;
    }
    fallbackText.push(`[${part.type}]`);
  }

  if (fallbackText.length > 0) {
    blocks.push({ type: 'text', text: fallbackText.join('\n') });
  }
  return blocks.length > 0 ? blocks : null;
}
