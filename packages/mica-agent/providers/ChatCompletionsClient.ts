import { OpenAI } from 'openai';
import { micaTools } from '@packages/mica-tools/index.js';
import {
  resolveChatCompletionsEffortParams,
  type EffortOption,
  type ProviderDefinition,
} from '@packages/mica-config/index.js';
import {
  BaseAgent,
  throwIfAgentMaxTurnsReached,
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
import { compactHistoricalToolResultText, MAX_HISTORICAL_TOOL_RESULT_CHARS } from './historyCompaction.js';
import { executeProviderToolCall, interruptedToolOutput, throwIfQueryStopped } from './providerHelpers.js';
import type { ModelClientOptions } from './types.js';

export type ChatCompletionsUsageRecord = AgentUsageRecord & {
  provider: 'openai_chat_completions';
  rawUsage: NonNullable<OpenAI.Chat.Completions.ChatCompletionChunk['usage']>;
  promptTokens: number;
};

function hasVisibleTextSuffix(text: string): boolean {
  return text.length > 0 && !text.endsWith('\n\n');
}

function getClient(options: ModelClientOptions) {
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });
}

export class ChatCompletionsClient extends BaseAgent<
  ModelClientOptions,
  OpenAI.Chat.Completions.ChatCompletionMessageParam,
  ChatCompletionsUsageRecord
> {
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  usageHistory: ChatCompletionsUsageRecord[] = [];
  lastUsage: ChatCompletionsUsageRecord | undefined;
  private turnId = 0;
  model!: string;
  apiKey: string | undefined;
  baseURL: string | undefined;
  effort: EffortOption | undefined;
  provider!: ProviderDefinition;
  tools: boolean;
  toolFilter: ModelClientOptions['toolFilter'];
  toolContext: unknown;
  systemPrompt: ModelClientOptions['systemPrompt'];
  constructor(options: ModelClientOptions) {
    super();
    this.tools = true;
    this.configure(options);
  }
  configure(options: ModelClientOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL;
    this.effort = options.effort;
    this.provider = options.provider;
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
  loadSnapshot(
    snapshot: AgentSnapshot<OpenAI.Chat.Completions.ChatCompletionMessageParam, ChatCompletionsUsageRecord>,
  ) {
    this.turnId = this.loadSnapshotState(
      { ...snapshot, messages: compactHistoricalToolResults(repairChatCompletionsToolResults(snapshot.messages)) },
      (message) => message.role !== 'system',
    );
  }
  toConversationMessages(): AgentConversationMessage[] {
    return this.messages.flatMap((message) => {
      if (message.role !== 'user' && message.role !== 'assistant') return [];
      const content = openAIContentToMicaContent(message.content);
      if (!content) return [];
      return [{ role: message.role, content }];
    });
  }

  preserveAbortedTurn(question: AgentQueryContent, partialAnswer?: string): boolean {
    this.messages = compactHistoricalToolResults(this.messages);
    const hasCurrentTurn = this.messages.some(
      (message) => message.role === 'user' && isSameOpenAIUserContent(message.content, question),
    );
    const answer = partialAnswer?.trim();
    if (hasCurrentTurn) {
      if (answer) this.messages.push({ role: 'assistant', content: answer });
      return true;
    }

    this.messages.push({ role: 'user', content: micaContentToOpenAIContent(question) });
    if (answer) this.messages.push({ role: 'assistant', content: answer });
    return false;
  }

  private get openaiTools() {
    const defs = micaTools.getDefinitions(this.toolFilter);
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
      { role: 'system', content: resolveSystemPrompt(this.systemPrompt) },
      ...compactHistoricalToolResults(this.messages),
      { role: 'user', content: micaContentToOpenAIContent(question) },
    ];
    const commitCompleteIteration = async (takeNextInput: boolean) => {
      const sessionMessages = messages.filter((message) => message.role !== 'system');
      this.messages = takeNextInput ? sessionMessages : compactHistoricalToolResults(sessionMessages);
      if (!takeNextInput) return;
      const nextInput = await options?.onIterationComplete?.();
      if (nextInput !== null && nextInput !== undefined) {
        messages.push({ role: 'user', content: micaContentToOpenAIContent(nextInput) });
      }
    };
    let totalContent = '';
    let hasStreamedText = false;
    let streamTextEndsWithBlankLine = false;

    while (true) {
      throwIfQueryStopped(options);
      throwIfAgentMaxTurnsReached(options, requestIndex, totalContent);
      requestIndex++;
      const stream = await withRetry(
        () =>
          getClient(this).chat.completions.create(
            {
              model: this.model,
              messages,
              ...(this.tools
                ? {
                    tools: this.openaiTools,
                    tool_choice: 'auto' as const,
                  }
                : {}),
              ...this.reasoningParams,
              stream: true,
              stream_options: {
                include_usage: true,
              },
            },
            { signal: options?.signal },
          ),
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
          const { result } = await executeProviderToolCall({
            name: tc.function.name,
            argsText: tc.function.arguments,
            id: tc.id,
            parseArgs: () => JSON.parse(tc.function.arguments),
            signal: options?.signal,
            context: this.toolContext,
            toolFilter: this.toolFilter,
            onToolCall: this.onToolCall,
            onToolResult: this.onToolResult,
          });
          throwIfQueryStopped(options);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: result,
          });
        }
        await commitCompleteIteration(true);
      }
      if (!message.tool_calls || message.tool_calls.length === 0) {
        messages.push(message);
        await commitCompleteIteration(false);
        return totalContent || message.content || '';
      }
    }
  }

  private get reasoningParams(): Record<string, unknown> {
    return resolveChatCompletionsEffortParams(this.provider, this.effort ?? 'none');
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
    const record: ChatCompletionsUsageRecord = {
      provider: 'openai_chat_completions',
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

function resolveSystemPrompt(source: ModelClientOptions['systemPrompt']): string {
  if (typeof source === 'function') return source();
  return source ?? buildSystemPrompt();
}

function readReasoningContent(delta: unknown): string | undefined {
  if (!delta || typeof delta !== 'object' || !('reasoning_content' in delta)) return undefined;
  const reasoning = delta.reasoning_content;
  return typeof reasoning === 'string' ? reasoning : undefined;
}

function repairChatCompletionsToolResults(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const repaired: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== 'assistant' || !message.tool_calls?.length) {
      repaired.push(message);
      continue;
    }

    const toolCalls = message.tool_calls.filter((toolCall) => toolCall.type === 'function' && toolCall.id);
    if (toolCalls.length === 0) {
      repaired.push(message);
      continue;
    }

    const toolResults = new Map<string, OpenAI.Chat.Completions.ChatCompletionToolMessageParam>();
    let nextIndex = index + 1;
    while (messages[nextIndex]?.role === 'tool') {
      const toolMessage = messages[nextIndex] as OpenAI.Chat.Completions.ChatCompletionToolMessageParam;
      toolResults.set(toolMessage.tool_call_id, toolMessage);
      nextIndex++;
    }

    repaired.push(message);
    for (const toolCall of toolCalls) {
      repaired.push(toolResults.get(toolCall.id) ?? interruptedChatToolResult(toolCall.id));
    }
    index = nextIndex - 1;
  }
  return repaired;
}

function interruptedChatToolResult(toolCallId: string): OpenAI.Chat.Completions.ChatCompletionToolMessageParam {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: interruptedToolOutput(),
  };
}

function isSameOpenAIUserContent(
  left: OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content'],
  right: AgentQueryContent,
): boolean {
  return JSON.stringify(left) === JSON.stringify(micaContentToOpenAIContent(right));
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
    if (message.content.length <= MAX_HISTORICAL_TOOL_RESULT_CHARS) {
      return message;
    }

    return {
      ...message,
      content: compactHistoricalToolResultText(message.content),
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
