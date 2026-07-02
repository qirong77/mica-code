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
import { micaTools } from '@packages/mica-tools/index.js';
import type { EffortOption, ProviderDefinition } from '@packages/mica-config/index.js';
import {
  BaseAgent,
  type AgentContentBlockParam,
  type AgentConversationMessage,
  type AgentQueryContent,
  type AgentQueryOptions,
  type AgentSnapshot,
  type AgentUsageRecord,
} from '../core/Agent.js';
import { providerContentToAgentContent } from '../core/Content.js';
import { withRetry } from '../core/retry.js';
import { buildSystemPrompt } from '../prompt/index.js';
import { executeProviderToolCall, interruptedToolOutput, throwIfQueryStopped } from './providerHelpers.js';
import type { ModelClientOptions } from './types.js';

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
const THINKING_BUDGET_TOKENS: Partial<Record<EffortOption, number>> = {
  low: 1024,
  medium: 4096,
  high: 8192,
};

function getClient(options: ModelClientOptions) {
  return new Anthropic({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });
}

export class AnthropicAgent extends BaseAgent<ModelClientOptions, MessageParam, AnthropicUsageRecord> {
  messages: MessageParam[] = [];
  usageHistory: AnthropicUsageRecord[] = [];
  lastUsage: AnthropicUsageRecord | undefined;
  private turnId = 0;
  model!: string;
  apiKey: string | undefined;
  baseURL: string | undefined;
  provider!: ProviderDefinition;
  maxTokens: number;
  effort: EffortOption | undefined;
  tools: boolean;
  toolFilter: ModelClientOptions['toolFilter'];
  toolContext: unknown;
  systemPrompt: string | undefined;

  constructor(options: ModelClientOptions) {
    super();
    this.tools = true;
    this.maxTokens = DEFAULT_MAX_TOKENS;
    this.configure(options);
  }

  configure(options: ModelClientOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL;
    this.provider = options.provider;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.effort = options.effort ?? 'none';
    this.tools = options.tools ?? true;
    this.toolFilter = options.toolFilter;
    this.toolContext = options.toolContext;
    this.systemPrompt = options.systemPrompt;
  }

  reset() {
    this.messages = [];
    this.usageHistory = [];
    this.lastUsage = undefined;
    this.turnId = 0;
  }

  loadSnapshot(snapshot: AgentSnapshot<MessageParam, AnthropicUsageRecord>) {
    this.turnId = this.loadSnapshotState(
      { ...snapshot, messages: repairAnthropicToolResults(snapshot.messages) },
      (message) => message.role !== 'system',
    );
  }

  toConversationMessages(): AgentConversationMessage[] {
    return this.messages.flatMap((message) => {
      if (message.role !== 'user' && message.role !== 'assistant') return [];
      const content = anthropicContentToMicaContent(message.content);
      if (!content) return [];
      return [{ role: message.role, content }];
    });
  }

  preserveAbortedTurn(question: AgentQueryContent, partialAnswer?: string): boolean {
    const content = micaContentToAnthropicContent(question);
    const hasCurrentTurn = this.messages.some(
      (message) => message.role === 'user' && JSON.stringify(message.content) === JSON.stringify(content),
    );
    const answer = partialAnswer?.trim();
    if (hasCurrentTurn) {
      if (answer) this.messages.push({ role: 'assistant', content: answer });
      return true;
    }

    this.messages.push({ role: 'user', content });
    if (answer) this.messages.push({ role: 'assistant', content: answer });
    return false;
  }

  private get anthropicTools(): Tool[] {
    return micaTools.getDefinitions(this.toolFilter).map((tool) => ({
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
    const commitCompleteIteration = async (takeNextInput: boolean) => {
      this.messages = messages;
      if (!takeNextInput) return;
      const nextInput = await options?.onIterationComplete?.();
      if (nextInput !== null && nextInput !== undefined) {
        appendAnthropicUserInput(messages, nextInput);
      }
    };
    let totalContent = '';

    while (true) {
      throwIfQueryStopped(options);
      requestIndex++;
      const stream = await withRetry(
        () =>
          getClient(this).messages.create(
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
          ),
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
          totalContent += delta.text;
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
        await commitCompleteIteration(false);
        return totalContent || content;
      }

      const toolResults: ContentBlockParam[] = [];
      for (const toolUse of toolUses) {
        throwIfQueryStopped(options);
        const toolInput = toToolInput(toolUse.input);
        const args = JSON.stringify(toolInput);
        const { result, isError } = await executeProviderToolCall({
          name: toolUse.name,
          argsText: args,
          id: toolUse.id,
          parseArgs: () => toolInput,
          signal: options?.signal,
          context: this.toolContext,
          toolFilter: this.toolFilter,
          onToolCall: this.onToolCall,
          onToolResult: this.onToolResult,
        });
        throwIfQueryStopped(options);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result,
          is_error: isError,
        });
      }

      appendAnthropicUserContent(messages, toolResults);
      await commitCompleteIteration(true);
    }
  }

  private get thinkingConfig() {
    if (!this.effort || this.effort === 'none') return undefined;
    const budget = THINKING_BUDGET_TOKENS[this.effort];
    if (!budget) return undefined;
    const budget_tokens = Math.min(budget, Math.max(1024, this.maxTokens - 1));
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

function repairAnthropicToolResults(messages: MessageParam[]): MessageParam[] {
  const repaired: MessageParam[] = [];
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant' && pending.size > 0) {
      repaired.push(interruptedAnthropicToolResultMessage(pending));
      pending.clear();
    }

    repaired.push(message);
    for (const part of toAnthropicContentBlocks(message.content)) {
      if (part.type === 'tool_use') {
        pending.add(part.id);
      } else if (part.type === 'tool_result') {
        pending.delete(part.tool_use_id);
      }
    }
  }

  if (pending.size > 0) repaired.push(interruptedAnthropicToolResultMessage(pending));
  return repaired;
}

function interruptedAnthropicToolResultMessage(toolUseIds: Iterable<string>): MessageParam {
  return {
    role: 'user',
    content: Array.from(toolUseIds, (toolUseId) => ({
      type: 'tool_result' as const,
      tool_use_id: toolUseId,
      content: interruptedToolOutput(),
      is_error: true,
    })),
  };
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

function appendAnthropicUserInput(messages: MessageParam[], input: AgentQueryContent): void {
  appendAnthropicUserContent(messages, micaContentToAnthropicContent(input));
}

function appendAnthropicUserContent(messages: MessageParam[], content: MessageParam['content']): void {
  const last = messages.at(-1);
  if (last?.role !== 'user') {
    messages.push({ role: 'user', content });
    return;
  }

  last.content = [...toAnthropicContentBlocks(last.content), ...toAnthropicContentBlocks(content)];
}

function toAnthropicContentBlocks(content: MessageParam['content']): ContentBlockParam[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  return content;
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

function toToolInput(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function anthropicContentToMicaContent(content: MessageParam['content']): string | AgentContentBlockParam[] | null {
  return providerContentToAgentContent(content, (part) => {
    if (part.type === 'text' && typeof part.text === 'string') {
      return { type: 'text', text: part.text };
    }
    if (part.type === 'image') return '[Image]';
    if (part.type === 'tool_use') return `[Tool: ${String(part.name)}]`;
    if (part.type === 'tool_result') return '[Tool result]';
    return typeof part.type === 'string' ? `[${part.type}]` : null;
  });
}
