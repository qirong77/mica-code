import { OpenAI } from 'openai';
import type {
  FunctionTool,
  Response,
  ResponseFunctionCallOutputItemList,
  ResponseInputItem,
  ResponseInputMessageContentList,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseStreamEvent,
  ResponseUsage,
} from 'openai/resources/responses/responses.js';
import { micaTools } from '@packages/mica-tools/index.js';
import {
  resolveResponsesReasoningParams,
  resolveModelRequestPatch,
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
import { withRetry } from '../core/retry.js';
import { buildSystemPrompt } from '../prompt/index.js';
import { compactHistoricalToolResultText } from './historyCompaction.js';
import { executeProviderToolCall, interruptedToolOutput, throwIfQueryStopped } from './providerHelpers.js';
import type { ModelClientOptions } from './types.js';

export type ResponsesUsageRecord = AgentUsageRecord & {
  provider: 'openai_responses';
  rawUsage: ResponseUsage;
};

type PendingToolCall = {
  id?: string;
  callId: string;
  name: string;
  arguments: string;
};

const RESPONSE_TERMINAL_ERROR_TYPES = new Set(['error', 'response.failed', 'response.incomplete']);

function getClient(options: ModelClientOptions) {
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });
}

function hasVisibleTextSuffix(text: string): boolean {
  return text.length > 0 && !text.endsWith('\n\n');
}

export class ResponsesClient extends BaseAgent<ModelClientOptions, ResponseInputItem, ResponsesUsageRecord> {
  messages: ResponseInputItem[] = [];
  usageHistory: ResponsesUsageRecord[] = [];
  lastUsage: ResponsesUsageRecord | undefined;
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

  loadSnapshot(snapshot: AgentSnapshot<ResponseInputItem, ResponsesUsageRecord>) {
    this.turnId = this.loadSnapshotState({
      ...snapshot,
      messages: prepareHistoricalResponsesInput(repairResponsesToolResults(snapshot.messages)),
    });
  }

  toConversationMessages(): AgentConversationMessage[] {
    return this.messages.flatMap((item) => {
      if (item.type !== 'message') return [];
      if (item.role !== 'user' && item.role !== 'assistant') return [];
      const content = responseMessageToAgentContent(item);
      return content.length > 0 ? [{ role: item.role, content }] : [];
    });
  }

  preserveAbortedTurn(question: AgentQueryContent, partialAnswer?: string): boolean {
    this.messages = prepareHistoricalResponsesInput(this.messages);
    const content = micaContentToResponsesContent(question);
    const hasCurrentTurn = this.messages.some(
      (item) =>
        item.type === 'message' && item.role === 'user' && JSON.stringify(item.content) === JSON.stringify(content),
    );
    const answer = partialAnswer?.trim();
    if (hasCurrentTurn) {
      if (answer) this.messages.push({ type: 'message', role: 'assistant', content: answer });
      return true;
    }

    this.messages.push({ type: 'message', role: 'user', content });
    if (answer) this.messages.push({ type: 'message', role: 'assistant', content: answer });
    return false;
  }

  private get responseTools(): FunctionTool[] {
    return micaTools.getDefinitions(this.toolFilter).map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema as Record<string, unknown>,
      strict: false,
    }));
  }

  async query(question: AgentQueryContent, options?: AgentQueryOptions): Promise<string> {
    const turnId = ++this.turnId;
    let requestIndex = 0;
    const systemPrompt = resolveSystemPrompt(this.systemPrompt);
    const messages: ResponseInputItem[] = [
      ...prepareHistoricalResponsesInput(this.messages),
      { type: 'message', role: 'user', content: micaContentToResponsesContent(question) },
    ];
    const commitCompleteIteration = async (takeNextInput: boolean) => {
      this.messages = takeNextInput
        ? stripUnusableResponseInputItems(messages)
        : prepareHistoricalResponsesInput(messages);
      if (!takeNextInput) return;
      const nextInput = await options?.onIterationComplete?.();
      if (nextInput !== null && nextInput !== undefined) {
        messages.push({ type: 'message', role: 'user', content: micaContentToResponsesContent(nextInput) });
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
          getClient(this).responses.create(
            {
              model: this.model,
              instructions: systemPrompt,
              input: messages,
              ...(this.tools
                ? {
                    tools: this.responseTools,
                    tool_choice: 'auto' as const,
                  }
                : {}),
              ...this.reasoningParams,
              stream: true,
            },
            { signal: options?.signal },
          ),
        { signal: options?.signal },
      );

      const contentSeparator: string =
        requestIndex > 1 && hasStreamedText && !streamTextEndsWithBlankLine ? '\n\n' : '';
      let emittedContentSeparator = false;
      let content = '';
      let completedResponse: Response | undefined;
      const outputItems: ResponseInputItem[] = [];
      const toolCalls = new Map<number, PendingToolCall>();

      for await (const event of stream) {
        throwIfQueryStopped(options);
        if (RESPONSE_TERMINAL_ERROR_TYPES.has(event.type)) throw responseEventError(event);

        if (event.type === 'response.output_text.delta') {
          const textDelta: string =
            contentSeparator && !emittedContentSeparator ? `${contentSeparator}${event.delta}` : event.delta;
          emittedContentSeparator = true;
          content += textDelta;
          totalContent += textDelta;
          hasStreamedText = true;
          streamTextEndsWithBlankLine = textDelta.endsWith('\n\n');
          this.onText?.(textDelta);
          continue;
        }

        if (event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.reasoning_text.delta') {
          this.onThinking?.(event.delta);
          continue;
        }

        if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
          toolCalls.set(event.output_index, {
            id: event.item.id,
            callId: event.item.call_id,
            name: event.item.name,
            arguments: event.item.arguments || '',
          });
          continue;
        }

        if (event.type === 'response.function_call_arguments.delta') {
          const pending = toolCalls.get(event.output_index);
          if (pending) pending.arguments += event.delta;
          continue;
        }

        if (event.type === 'response.function_call_arguments.done') {
          const pending = toolCalls.get(event.output_index);
          if (pending) pending.arguments = event.arguments;
          continue;
        }

        if (event.type === 'response.output_item.done') {
          const inputItem = responseOutputItemToInputItem(event.item);
          if (inputItem) outputItems.push(inputItem);
          if (event.item.type === 'message' && !content) {
            const finalText = responseOutputMessageText(event.item);
            if (finalText) {
              content = finalText;
              totalContent += finalText;
              hasStreamedText = true;
              streamTextEndsWithBlankLine = finalText.endsWith('\n\n');
              this.onText?.(finalText);
            }
          } else if (event.item.type === 'function_call') {
            toolCalls.set(event.output_index, {
              id: event.item.id,
              callId: event.item.call_id,
              name: event.item.name,
              arguments: event.item.arguments,
            });
          }
          continue;
        }

        if (event.type === 'response.completed') {
          completedResponse = event.response;
        }
      }

      if (completedResponse?.usage) {
        this.recordUsage(completedResponse.usage, {
          model: completedResponse.model,
          turnId,
          requestIndex,
          messageCount: messages.length,
        });
      }

      messages.push(...outputItems);
      const completedToolCalls = Array.from(toolCalls.values()).filter((toolCall) => toolCall.callId && toolCall.name);

      if (completedToolCalls.length === 0) {
        await commitCompleteIteration(false);
        return totalContent || content || completedResponse?.output_text || '';
      }

      if (hasVisibleTextSuffix(content)) {
        totalContent += '\n\n';
        streamTextEndsWithBlankLine = true;
        this.onText?.('\n\n');
      }

      for (const toolCall of completedToolCalls) {
        throwIfQueryStopped(options);
        const { result, images } = await executeProviderToolCall({
          name: toolCall.name,
          argsText: toolCall.arguments,
          id: toolCall.callId,
          parseArgs: () => JSON.parse(toolCall.arguments || '{}'),
          signal: options?.signal,
          context: this.toolContext,
          toolFilter: this.toolFilter,
          onToolCall: this.onToolCall,
          onToolResult: this.onToolResult,
        });
        throwIfQueryStopped(options);
        messages.push({
          type: 'function_call_output',
          call_id: toolCall.callId,
          output: responsesToolOutput(result, images),
        });
      }

      await commitCompleteIteration(true);
    }
  }

  private get reasoningParams(): Record<string, unknown> {
    if (!this.provider || !this.effort) return {};
    return (
      resolveModelRequestPatch(this.model, this.effort, 'openai_responses') ??
      resolveResponsesReasoningParams(this.provider, this.effort)
    );
  }

  private recordUsage(
    usage: ResponseUsage,
    metadata: {
      model?: string;
      turnId: number;
      requestIndex: number;
      messageCount: number;
    },
  ): void {
    const inputTokens = usage.input_tokens ?? 0;
    const cachedTokens = usage.input_tokens_details?.cached_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const totalTokens = usage.total_tokens ?? inputTokens + outputTokens;
    const paidTokenRate = totalTokens > 0 ? Math.max(0, totalTokens - cachedTokens) / totalTokens : 0;
    const record: ResponsesUsageRecord = {
      provider: 'openai_responses',
      turnId: metadata.turnId,
      requestIndex: metadata.requestIndex,
      messageCount: metadata.messageCount,
      model: metadata.model,
      inputTokens,
      cachedInputTokens: cachedTokens,
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

function resolveSystemPrompt(source: ModelClientOptions['systemPrompt']): string {
  if (typeof source === 'function') return source();
  return source ?? buildSystemPrompt();
}

function micaContentToResponsesContent(content: AgentQueryContent): ResponseInputMessageContentList {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];

  return content.map((part) => {
    if (part.type === 'text') return { type: 'input_text', text: part.text };
    return {
      type: 'input_image',
      detail: 'auto',
      image_url: `data:${part.source.media_type};base64,${part.source.data}`,
    };
  });
}

function responsesToolOutput(
  text: string,
  images: Array<Extract<AgentContentBlockParam, { type: 'image' }>>,
): string | ResponseFunctionCallOutputItemList {
  if (images.length === 0) return text;
  return [
    { type: 'input_text', text },
    ...images.map((image) => ({
      type: 'input_image' as const,
      detail: 'auto' as const,
      image_url: `data:${image.source.media_type};base64,${image.source.data}`,
    })),
  ];
}

type ResponseMessageContentPart = ResponseInputMessageContentList[number] | ResponseOutputMessage['content'][number];
type AgentImageSource = Extract<AgentContentBlockParam, { type: 'image' }>['source'];

function responseMessageToAgentContent(message: {
  content: string | ResponseInputMessageContentList | ResponseOutputMessage['content'];
}): AgentConversationMessage['content'] {
  if (typeof message.content === 'string') return message.content ? [{ type: 'text', text: message.content }] : [];
  return (message.content as ResponseMessageContentPart[]).flatMap((part): AgentContentBlockParam[] => {
    if (part.type === 'input_text') return [{ type: 'text' as const, text: part.text }];
    if (part.type === 'output_text') return [{ type: 'text' as const, text: part.text }];
    if (part.type === 'refusal') return [{ type: 'text' as const, text: part.refusal }];
    if (part.type === 'input_image' && part.image_url) {
      const parsed = parseDataUrl(part.image_url);
      return parsed ? [{ type: 'image' as const, source: parsed }] : [];
    }
    return [];
  });
}

function responseOutputMessageText(message: ResponseOutputMessage): string {
  return message.content.map((part) => (part.type === 'output_text' ? part.text : part.refusal)).join('');
}

function responseOutputItemToInputItem(item: ResponseOutputItem): ResponseInputItem | null {
  switch (item.type) {
    case 'message':
    case 'function_call':
      return item;
    case 'reasoning':
      return item.encrypted_content ? item : null;
    default:
      return null;
  }
}

function repairResponsesToolResults(messages: ResponseInputItem[]): ResponseInputItem[] {
  const repaired: ResponseInputItem[] = [];
  const pending = new Set<string>();
  for (const item of messages) {
    if (item.type === 'message' && pending.size > 0) {
      repaired.push(...Array.from(pending, interruptedResponsesToolResult));
      pending.clear();
    }

    repaired.push(item);
    if (item.type === 'function_call' && item.call_id) {
      pending.add(item.call_id);
    } else if (item.type === 'function_call_output') {
      pending.delete(item.call_id);
    }
  }

  if (pending.size > 0) repaired.push(...Array.from(pending, interruptedResponsesToolResult));
  return repaired;
}

function prepareHistoricalResponsesInput(messages: ResponseInputItem[]): ResponseInputItem[] {
  return stripUnusableResponseInputItems(messages).map((item) => {
    if (item.type !== 'function_call_output' || typeof item.output !== 'string') return item;
    const compacted = compactHistoricalToolResultText(item.output);
    return compacted === item.output ? item : { ...item, output: compacted };
  });
}

function stripUnusableResponseInputItems(messages: ResponseInputItem[]): ResponseInputItem[] {
  return messages.filter((item) => item.type !== 'reasoning' || Boolean(item.encrypted_content));
}

function interruptedResponsesToolResult(callId: string): ResponseInputItem {
  return {
    type: 'function_call_output',
    call_id: callId,
    output: interruptedToolOutput(),
  };
}

function parseDataUrl(url: string): AgentImageSource | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(url);
  if (!match || !isSupportedImageMediaType(match[1])) return null;
  return { type: 'base64', media_type: match[1], data: match[2]! };
}

function isSupportedImageMediaType(value: string): value is AgentImageSource['media_type'] {
  return value === 'image/jpeg' || value === 'image/png' || value === 'image/gif' || value === 'image/webp';
}

function responseEventError(event: ResponseStreamEvent): Error {
  if (event.type === 'error') return errorWithCode(`${event.code ?? 'unknown'}: ${event.message}`, event.code);
  if (event.type === 'response.failed') {
    const error = event.response.error;
    return errorWithCode(error ? `${error.code ?? 'unknown'}: ${error.message}` : 'Response failed', error?.code);
  }
  if (event.type === 'response.incomplete') {
    return new Error(`Response incomplete: ${event.response.incomplete_details?.reason ?? 'unknown'}`);
  }
  return new Error(`Unhandled response stream event: ${event.type}`);
}

function errorWithCode(message: string, code: string | null | undefined): Error {
  const error = new Error(message);
  if (code) Object.assign(error, { code });
  return error;
}
