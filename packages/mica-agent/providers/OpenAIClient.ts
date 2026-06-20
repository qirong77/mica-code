import { OpenAI } from 'openai';
import { micaTools } from '@packages/mica-tools/index.js';
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
import { buildSystemPrompt } from '../prompt/index.js';
import { OpenAIHistoryNormalizer } from './OpenAIHistoryNormalizer.js';

export type OpenAIClientOptions = {
  model: string;
  apiKey?: string;
  baseURL?: string;
  effort?: string;
  tools?: boolean;
  systemPrompt?: string;
};

export type OpenAIUsageRecord = AgentUsageRecord & {
  provider: 'openai';
  rawUsage: NonNullable<OpenAI.Chat.Completions.ChatCompletionChunk['usage']>;
  promptTokens: number;
};

export type UsageRecord = OpenAIUsageRecord;

const MAX_HISTORICAL_TOOL_RESULT_LENGTH = 12_000;

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

function hasVisibleTextSuffix(text: string): boolean {
  return text.length > 0 && !text.endsWith('\n\n');
}

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
  readonly historyNormalizer = new OpenAIHistoryNormalizer();
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
    this.turnId = this.loadSnapshotState(snapshot, (message) => message.role !== 'system');
  }
  toConversationMessages(): AgentConversationMessage[] {
    return this.messages.flatMap((message) => {
      if (message.role !== 'user' && message.role !== 'assistant') return [];
      const content = openAIContentToMicaContent(message.content);
      if (!content) return [];
      return [{ role: message.role, content }];
    });
  }
  private get openaiTools() {
    const defs = micaTools.getDefinitions();
    return defs.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }
  async query(question: AgentQueryContent, options?: AgentQueryOptions): Promise<string> {
    const turnId = ++this.turnId;
    let requestIndex = 0;
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.systemPrompt ?? buildSystemPrompt() },
      ...compactHistoricalToolResults(this.messages),
      { role: 'user', content: micaContentToOpenAIContent(question) },
    ];
    let totalContent = '';
    let hasStreamedText = false;
    let streamTextEndsWithBlankLine = false;

    while (true) {
      throwIfQueryStopped(options);
      requestIndex++;
      const stream = await getClient(this).chat.completions.create(
        {
          model: this.model,
          messages,
          ...(this.tools
            ? {
                tools: this.openaiTools,
                tool_choice: 'auto' as const,
              }
            : {}),
          ...(this.effort && this.effort !== 'none'
            ? { reasoning_effort: this.effort as OpenAI.Chat.Completions.ChatCompletionReasoningEffort }
            : {}),
          stream: true,
          stream_options: {
            include_usage: true,
          },
        },
        { signal: options?.signal },
      );

      let content = '';
      const contentSeparator: string =
        requestIndex > 1 && hasStreamedText && !streamTextEndsWithBlankLine ? '\n\n' : '';
      let emittedContentSeparator = false;
      const toolCallsMap = new Map<number, { id: string; function: { name: string; arguments: string } }>();

      for await (const chunk of stream) {
        throwIfQueryStopped(options);
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
            const textDelta: string =
              contentSeparator && !emittedContentSeparator ? `${contentSeparator}${delta.content}` : delta.content;
            emittedContentSeparator = true;
            content += textDelta;
            totalContent += textDelta;
            hasStreamedText = true;
            streamTextEndsWithBlankLine = textDelta.endsWith('\n\n');
            throwIfQueryStopped(options);
            this.onText?.(textDelta);
          }
          const reasoning = readReasoningContent(delta);
          if (typeof reasoning === 'string' && reasoning) {
            throwIfQueryStopped(options);
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
        if (hasVisibleTextSuffix(content)) {
          content += '\n\n';
          totalContent += '\n\n';
          message.content = content;
          streamTextEndsWithBlankLine = true;
          this.onText?.('\n\n');
        }
        messages.push(message);
        for (const tc of message.tool_calls) {
          throwIfQueryStopped(options);
          if (tc.type !== 'function') continue;
          this.onToolCall?.(tc.function.name, tc.function.arguments, tc.id);
          let result: string;
          try {
            result = await micaTools.execute(tc.function.name, JSON.parse(tc.function.arguments), {
              signal: options?.signal,
            });
          } catch (e) {
            result = `工具执行失败: ${e instanceof Error ? e.message : String(e)}`;
          }
          throwIfQueryStopped(options);
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
        return totalContent || message.content || '';
      }
    }
  }

  private recordUsage(
    usage: NonNullable<OpenAI.Chat.Completions.ChatCompletionChunk['usage']>,
    metadata: {
      model?: string;
      turnId: number;
      requestIndex: number;
      messageCount: number;
    },
  ): void {
    const promptTokens = usage.prompt_tokens ?? 0;
    const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const outputTokens = usage.completion_tokens ?? 0;
    const totalTokens = usage.total_tokens ?? promptTokens + outputTokens;
    const paidTokenRate = totalTokens > 0 ? Math.max(0, totalTokens - cachedTokens) / totalTokens : 0;
    const record: OpenAIUsageRecord = {
      provider: 'openai',
      turnId: metadata.turnId,
      requestIndex: metadata.requestIndex,
      messageCount: metadata.messageCount,
      model: metadata.model,
      inputTokens: promptTokens,
      cachedInputTokens: cachedTokens,
      outputTokens,
      totalTokens,
      paidTokenRate,
      rawUsage: usage,
      promptTokens,
    };

    this.lastUsage = record;
    this.usageHistory.push(record);
    this.onUsage?.(record);
  }
}

function readReasoningContent(delta: unknown): string | undefined {
  if (!delta || typeof delta !== 'object' || !('reasoning_content' in delta)) return undefined;
  const reasoning = delta.reasoning_content;
  return typeof reasoning === 'string' ? reasoning : undefined;
}

export function createOpenAIClient(options: OpenAIClientOptions): OpenAIClient {
  return new OpenAIClient(options);
}

export function createSubAgent(options: OpenAIClientOptions): OpenAIClient {
  return new OpenAIClient({
    ...options,
    effort: 'none',
    tools: false,
  });
}

function micaContentToOpenAIContent(
  content: AgentQueryContent,
): OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content'] {
  if (typeof content === 'string') return content;

  return content.map((part) => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }

    return {
      type: 'image_url',
      image_url: {
        url: `data:${part.source.media_type};base64,${part.source.data}`,
      },
    };
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
): string | AgentContentBlockParam[] | null {
  return providerContentToAgentContent(content, (part) => {
    if (part.type === 'text' && typeof part.text === 'string') {
      return { type: 'text', text: part.text };
    }
    if (part.type === 'image_url') return '[Image]';
    return typeof part.type === 'string' ? `[${part.type}]` : null;
  });
}
