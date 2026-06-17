import { OpenAI } from 'openai';
import { executeTool, getToolDefinitions } from '../tools';
import { BaseAgent, type AgentSnapshot, type AgentUsageRecord } from './IAgent';
import type { MicaUiConversationMessage, MicaUiContentBlockParam } from '../mica-ui/types';
import { buildSystemPrompt } from './prompt';

export type OpenAIClientOptions = {
  model: string;
  apiKey?: string;
  baseURL?: string;
  effort?: string;
  tools?: boolean;
  systemPrompt?: string;
};

export type UsageRecord = AgentUsageRecord;

const MAX_HISTORICAL_TOOL_RESULT_LENGTH = 12_000;

function getClient(options: OpenAIClientOptions) {
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });
}

export class OpenAIClient extends BaseAgent<
  OpenAIClientOptions,
  OpenAI.Chat.Completions.ChatCompletionMessageParam,
  UsageRecord
> {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  usageHistory: UsageRecord[] = [];
  lastUsage: UsageRecord | undefined;
  private turnId = 0;
  model: string;
  apiKey: string | undefined;
  baseURL: string | undefined;
  effort: string | undefined;
  tools: boolean;
  systemPrompt: string | undefined;
  constructor(options: string | OpenAIClientOptions) {
    super();
    this.tools = true;
    if (typeof options === 'string') {
      this.model = options;
      this.apiKey = process.env.OPENAI_API_KEY;
      return;
    }
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL;
    this.effort = options.effort;
    this.tools = options.tools ?? true;
    this.systemPrompt = options.systemPrompt;
  }
  configure(options: OpenAIClientOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL;
    this.effort = options.effort;
    this.tools = options.tools ?? true;
    this.systemPrompt = options.systemPrompt;
  }
  reset() {
    this.messages = [];
    this.usageHistory = [];
    this.lastUsage = undefined;
    this.turnId = 0;
  }
  loadSnapshot(snapshot: AgentSnapshot<OpenAI.Chat.Completions.ChatCompletionMessageParam, UsageRecord>) {
    this.messages = snapshot.messages.filter((message) => message.role !== 'system');
    this.usageHistory = snapshot.usageHistory;
    this.lastUsage = snapshot.lastUsage;
    this.turnId = this.usageHistory.reduce((max, usage) => Math.max(max, usage.turn_id), 0);
  }
  toConversationMessages(): MicaUiConversationMessage[] {
    return this.messages.flatMap((message) => {
      if (message.role !== 'user' && message.role !== 'assistant') return [];
      const content = openAIContentToMicaContent(message.content);
      if (!content) return [];
      return [{ role: message.role, content }];
    });
  }
  private get openaiTools() {
    const defs = getToolDefinitions();
    return defs.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }
  async query(question: string): Promise<string> {
    const turnId = ++this.turnId;
    let requestIndex = 0;
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.systemPrompt ?? buildSystemPrompt() },
      ...compactHistoricalToolResults(this.messages),
      { role: 'user', content: question },
    ];

    while (true) {
      requestIndex++;
      const stream = await getClient(this).chat.completions.create({
        model: this.model,
        messages,
        ...(this.tools
          ? {
              tools: this.openaiTools,
              tool_choice: 'auto' as const,
            }
          : {}),
        ...(this.effort && this.effort !== 'none' ? { reasoning_effort: this.effort as any } : {}),
        stream: true,
        stream_options: {
          include_usage: true,
        },
      });

      let content = '';
      const toolCallsMap = new Map<number, { id: string; function: { name: string; arguments: string } }>();

      for await (const chunk of stream) {
        if (chunk.usage) {
          this.recordUsage(chunk.usage, {
            model: chunk.model,
            turnId,
            requestIndex,
            messageCount: messages.length,
          });
        }
        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        for (const choice of choices) {
          const delta = choice?.delta;
          if (!delta) continue;
          if (typeof delta.content === 'string' && delta.content) {
            content += delta.content;
            this.onText?.(delta.content);
          }
          const reasoning = (delta as any).reasoning_content;
          if (typeof reasoning === 'string' && reasoning) {
            this.onThinking?.(reasoning);
          }
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const toolCallIndex = typeof tc.index === 'number' ? tc.index : 0;
              let existing = toolCallsMap.get(toolCallIndex);
              if (!existing) {
                existing = {
                  id: tc.id || '',
                  function: { name: '', arguments: '' },
                };
                toolCallsMap.set(toolCallIndex, existing);
              }
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.function.name += tc.function.name;
              if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
            }
          }
        }
      }

      const toolCalls =
        toolCallsMap.size > 0
          ? Array.from(toolCallsMap.values())
              .filter((tc) => tc.id && tc.function.name)
              .map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: {
                  name: tc.function.name,
                  arguments: tc.function.arguments,
                },
              }))
          : undefined;

      const message: OpenAI.Chat.Completions.ChatCompletionMessage = {
        role: 'assistant',
        content: content || null,
        refusal: null,
        tool_calls: toolCalls,
      };

      if (message.tool_calls && message.tool_calls.length > 0) {
        messages.push(message);
        for (const tc of message.tool_calls) {
          if (tc.type !== 'function') continue;
          this.onToolCall?.(tc.function.name, tc.function.arguments, tc.id);
          let result: string;
          try {
            result = await executeTool(tc.function.name, JSON.parse(tc.function.arguments));
          } catch (e) {
            result = `工具执行失败: ${e instanceof Error ? e.message : String(e)}`;
          }
          this.onToolResult?.(tc.function.name, result, tc.id);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: result,
          });
        }
      }
      if (!message.tool_calls || message.tool_calls.length === 0) {
        messages.push(message);
        this.messages = messages.filter((message) => message.role !== 'system');
        return message.content || '';
      }
    }
  }

  private recordUsage(
    usage: Record<string, any>,
    metadata: {
      model?: string;
      turnId: number;
      requestIndex: number;
      messageCount: number;
    },
  ): void {
    const promptTokens = usage.prompt_tokens ?? 0;
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const uncachedTokens = Math.max(0, promptTokens - cachedTokens);
    const outputTokens = usage.completion_tokens ?? 0;
    const totalTokens = usage.total_tokens ?? promptTokens + outputTokens;
    const hitRate = promptTokens > 0 ? cachedTokens / promptTokens : 0;
    const record: UsageRecord = {
      turn_id: metadata.turnId,
      request_index: metadata.requestIndex,
      message_count: metadata.messageCount,
      model: metadata.model,
      usage,
      tokens: {
        input: promptTokens,
        cached_input: cachedTokens,
        uncached_input: uncachedTokens,
        output: outputTokens,
        total: totalTokens,
      },
      prompt_cache: {
        prompt_tokens: promptTokens,
        cached_tokens: cachedTokens,
        uncached_tokens: uncachedTokens,
        hit_rate: hitRate,
        hit_rate_percent: `${(hitRate * 100).toFixed(2)}%`,
      },
    };

    this.lastUsage = record;
    this.usageHistory.push(record);
    this.onUsage?.(record);
  }
}

export function createSubAgent(options: OpenAIClientOptions): OpenAIClient {
  return new OpenAIClient({
    ...options,
    effort: 'none',
    tools: false,
  });
}

function compactHistoricalToolResults(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (message.role !== 'tool') return message;
    if (typeof message.content !== 'string') return message;
    if (message.content.length <= MAX_HISTORICAL_TOOL_RESULT_LENGTH) {
      return message;
    }

    const head = message.content.slice(0, MAX_HISTORICAL_TOOL_RESULT_LENGTH);
    const omitted = message.content.length - head.length;
    return {
      ...message,
      content: [
        head,
        '',
        `[历史工具结果已压缩，省略 ${omitted} 字符。如需完整内容，请重新读取对应文件或重新运行相关工具。]`,
      ].join('\n'),
    };
  });
}

function openAIContentToMicaContent(
  content: OpenAI.Chat.Completions.ChatCompletionMessageParam['content'] | null | undefined,
): string | MicaUiContentBlockParam[] | null {
  if (!content) return null;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);

  const blocks: MicaUiContentBlockParam[] = [];
  const fallbackText: string[] = [];

  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if ('type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if ('type' in part && part.type === 'image_url') {
      fallbackText.push('[Image]');
      continue;
    }
    if ('type' in part && typeof part.type === 'string') {
      fallbackText.push(`[${part.type}]`);
    }
  }

  if (fallbackText.length > 0) {
    blocks.push({ type: 'text', text: fallbackText.join('\n') });
  }
  return blocks.length > 0 ? blocks : null;
}
