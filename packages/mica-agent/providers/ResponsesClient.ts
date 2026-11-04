import { OpenAI } from 'openai';
import { randomUUID } from 'node:crypto';
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
import { resolveEffortParams, type EffortOption, type ProviderDefinition } from '@packages/mica-config/index.js';
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
import { isRetryableError, withRetry } from '../core/retry.js';
import { withIdleTimeout } from '../core/streamIdleTimeout.js';
import { buildSystemPrompt } from '../prompt/index.js';
import { compactHistoricalToolResultText } from './historyCompaction.js';
import { executeProviderToolCalls, interruptedToolOutput, throwIfQueryStopped } from './providerHelpers.js';
import { sendWithEffortFallback } from './effortFallback.js';
import { imageOmittedPlaceholder } from './imagePlaceholder.js';
import type { ModelClientOptions } from './types.js';

export type ResponsesUsageRecord = AgentUsageRecord & {
  provider: 'openai_responses';
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

type ReasoningTextEvent = {
  type:
    | 'response.reasoning_summary_text.delta'
    | 'response.reasoning_summary_text.done'
    | 'response.reasoning_text.delta'
    | 'response.reasoning_text.done';
  item_id?: string;
  output_index?: number;
  summary_index?: number;
  content_index?: number;
  delta?: string;
  text?: string;
};

type ReasoningPart = {
  itemId: string | undefined;
  outputIndex: number | undefined;
  index: number | undefined;
  indexKind: 'summary' | 'content';
  text: string;
  emittedLength: number;
  done: boolean;
  ambiguousDone: boolean;
};

/** Orders display-only reasoning without changing the Responses input. */
class ResponsesReasoningParts {
  private readonly parts: ReasoningPart[] = [];
  private next = 0;
  private hasVisiblePart = false;
  private safe = true;

  get canCheckpointRequest(): boolean {
    return this.safe && !this.parts.some((part) => part.ambiguousDone && !part.done);
  }

  constructor(
    private readonly emit: (text: string) => void,
    private readonly checkpoint: () => void,
    private readonly checkStopped: () => void,
  ) {}

  accept(event: ReasoningTextEvent): void {
    if (!this.safe) return;
    const indexKind = event.type.startsWith('response.reasoning_summary_text.') ? 'summary' : 'content';
    const rawIndex = indexKind === 'summary' ? event.summary_index : event.content_index;
    const index = typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : undefined;
    const itemId = typeof event.item_id === 'string' && event.item_id ? event.item_id : undefined;
    const outputIndex = typeof event.output_index === 'number' && Number.isInteger(event.output_index) && event.output_index >= 0
      ? event.output_index
      : undefined;
    const isDone = event.type.endsWith('.done');
    const isCompatible = (part: ReasoningPart) => {
      const sameItem = part.itemId !== undefined && itemId !== undefined
        ? part.itemId === itemId
        : part.outputIndex === undefined || outputIndex === undefined || part.outputIndex === outputIndex;
      return sameItem &&
        (part.index === undefined || index === undefined || (part.index === index && part.indexKind === indexKind));
    };

    // A fully identified part remains identifiable after it finishes, so late
    // duplicate done events cannot accidentally start another part.
    let part = (itemId !== undefined || outputIndex !== undefined) && index !== undefined
      ? this.parts.find((candidate) =>
          isCompatible(candidate) && candidate.index === index && candidate.indexKind === indexKind &&
          ((itemId !== undefined && candidate.itemId === itemId) ||
            (outputIndex !== undefined && candidate.outputIndex === outputIndex)))
      : undefined;
    if (!part) {
      // Omitted identities can only be associated when there is one compatible
      // live part. Interleaved parts with no distinguishing fields cannot be
      // reliably separated by any consumer of these events.
      const candidates = this.parts.filter((candidate) => !candidate.done && isCompatible(candidate));
      if (candidates.length > 1) {
        // An event with omitted identity cannot safely select among live parts.
        this.safe = false;
        return;
      }
      part = candidates[0];
      if (part && isDone) {
        const previousDuplicate = this.parts.findLast((candidate) =>
          candidate.done && isCompatible(candidate) &&
          (typeof event.text !== 'string' || candidate.text === event.text));
        if (previousDuplicate) {
          // Without a full identity, this could also be the new part's done.
          // Wait for an unambiguous done before checkpointing the new part.
          part.ambiguousDone = true;
          return;
        }
      }
      if (part) {
        if (part.index === undefined && index !== undefined) {
          part.index = index;
          part.indexKind = indexKind;
        }
      } else if (isDone) {
        const previous = this.parts.findLast((candidate) => candidate.done && isCompatible(candidate));
        if (previous) {
          // Missing identities cannot distinguish a second done-only part from
          // a conflicting duplicate. Keep the prior checkpoint, but never
          // manufacture another one from an ambiguous event.
          if (typeof event.text !== 'string' || event.text === previous.text) return;
          this.safe = false;
          return;
        }
      }
    }

    if (!part) {
      part = { itemId, outputIndex, index, indexKind, text: '', emittedLength: 0, done: false, ambiguousDone: false };
      this.parts.push(part);
    }
    part.itemId ??= itemId;
    part.outputIndex ??= outputIndex;
    if (part.done) {
      if (!isDone || (typeof event.text === 'string' && event.text !== part.text)) {
        // A completed, identified part is immutable. Its old checkpoint may
        // already have been delivered, but no later checkpoint is safe.
        this.safe = false;
      }
      return;
    }

    if (!isDone) {
      if (typeof event.delta === 'string') part.text += event.delta;
    } else {
      if (typeof event.text === 'string') {
        if (event.text.startsWith(part.text) || part.emittedLength === 0) {
          // The done event contains the complete part, including any omitted
          // suffix; an undisplayed buffer can also be replaced authoritatively.
          part.text = event.text;
        } else {
          // Once inconsistent deltas were displayed there is no callback to
          // replace just this part. Do not checkpoint it or anything after it.
          this.safe = false;
          return;
        }
      }
      part.done = true;
      part.ambiguousDone = false;
    }
    this.flush();
  }

  private flush(): void {
    while (this.next < this.parts.length) {
      const part = this.parts[this.next]!;
      const pending = part.text.slice(part.emittedLength);
      if (pending) {
        if (part.emittedLength === 0 && this.hasVisiblePart) {
          this.checkStopped();
          this.emit('\n\n');
        }
        this.checkStopped();
        this.emit(pending);
        part.emittedLength = part.text.length;
        this.hasVisiblePart = true;
      }
      if (!part.done) return;
      this.checkStopped();
      this.checkpoint();
      this.next++;
    }
  }
}

export function withResponsesReasoningSummary(patch: Record<string, unknown>): Record<string, unknown> {
  const reasoning = patch.reasoning;
  if (!reasoning || typeof reasoning !== 'object' || Array.isArray(reasoning) || 'summary' in reasoning) return patch;
  return { ...patch, reasoning: { ...reasoning, summary: 'auto' } };
}

export class ResponsesClient extends BaseAgent<ModelClientOptions, ResponseInputItem, ResponsesUsageRecord> {
  messages: ResponseInputItem[] = [];
  usageHistory: ResponsesUsageRecord[] = [];
  lastUsage: ResponsesUsageRecord | undefined;
  private turnId = 0;
  /**
   * Whether the running turn has already been synced into `this.messages` by a
   * completed iteration (`commitCompleteIteration`). It is the only reliable
   * "is this turn already in history" signal for `preserveAbortedTurn`: once a
   * tool iteration committed, the tail of the history is a tool result, not the
   * user message, so inspecting the last item appends the whole turn again.
   */
  private turnCommitted = false;
  model!: string;
  apiKey: string | undefined;
  baseURL: string | undefined;
  effort: EffortOption | undefined;
  provider!: ProviderDefinition;
  tools: boolean;
  toolFilter: ModelClientOptions['toolFilter'];
  toolContext: unknown;
  systemPrompt: ModelClientOptions['systemPrompt'];
  supportsVision!: boolean;

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
    this.supportsVision = options.supportsVision ?? true;
  }

  reset() {
    this.messages = [];
    this.usageHistory = [];
    this.lastUsage = undefined;
    this.turnId = 0;
    this.turnCommitted = false;
  }

  loadSnapshot(snapshot: AgentSnapshot<ResponseInputItem, ResponsesUsageRecord>) {
    this.turnCommitted = false;
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
    // Two ways the turn can already be in history: a completed iteration
    // committed it (`turnCommitted`, tail is then whatever the iteration ended
    // with), or the previous turn left an unanswered question with the same
    // text at the tail. Appending in either case duplicates the turn.
    const lastMessage = this.messages.at(-1);
    const hasCurrentTurn =
      this.turnCommitted ||
      (lastMessage?.type === 'message' &&
        lastMessage.role === 'user' &&
        JSON.stringify(lastMessage.content) === JSON.stringify(content));
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
    this.turnCommitted = false;
    let requestIndex = 0;
    const systemPrompt = resolveSystemPrompt(this.systemPrompt);
    let messages: ResponseInputItem[] = [
      ...prepareHistoricalResponsesInput(this.messages),
      { type: 'message' as const, role: 'user' as const, content: micaContentToResponsesContent(question) },
    ];
    const commitCompleteIteration = async (takeNextInput: boolean) => {
      this.messages = takeNextInput
        ? stripUnusableResponseInputItems(messages)
        : prepareHistoricalResponsesInput(messages);
      // From here on the turn (its question, tool calls and text) lives in
      // `this.messages`; an abort must not append it a second time.
      this.turnCommitted = true;
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
      if (options?.rewriteIterationMessages) {
        const rewritten = await options.rewriteIterationMessages(messages);
        throwIfQueryStopped(options);
        if (Array.isArray(rewritten)) {
          messages = rewritten as ResponseInputItem[];
          this.messages = stripUnusableResponseInputItems(messages);
          this.turnCommitted = true;
        }
      }
      requestIndex++;

      const contentSeparator: string =
        requestIndex > 1 && hasStreamedText && !streamTextEndsWithBlankLine ? '\n\n' : '';
      let emittedContentSeparator = false;
      let content = '';
      let completedResponse: Response | undefined;
      let outputItems: ResponseInputItem[] = [];
      let toolCalls = new Map<number, PendingToolCall>();
      let hasReasoningText = false;
      let reasoningParts: ResponsesReasoningParts | undefined;
      const wireMessages = stripImagesForVision(
        dropReplayedReasoningItems(toWireResponsesInput(messages)),
        this.supportsVision,
        this.model,
      );

      const requestTools = this.tools ? this.responseTools : undefined;
      // 与 Chat Completions 同一份口径：请求耗时、首字延迟、重试次数，见 onRequestEnd。
      const requestStartedAt = Date.now();
      let firstDeltaAt = 0;
      let requestAttempts = 1;
      let requestEndSent = false;
      const finishRequest = (info: {
        outcome: 'completed' | 'error' | 'aborted';
        toolCalls?: number;
        error?: unknown;
      }): void => {
        if (requestEndSent || !options?.onRequestEnd) return;
        requestEndSent = true;
        try {
          options.onRequestEnd({
            durationMs: Date.now() - requestStartedAt,
            firstTokenMs: firstDeltaAt ? firstDeltaAt - requestStartedAt : undefined,
            attempts: requestAttempts,
            outcome: info.outcome,
            toolCalls: info.toolCalls,
            error:
              info.error === undefined
                ? undefined
                : String((info.error as Error)?.message || info.error).slice(0, 200),
          });
        } catch {
          // Observation must not interrupt the model request.
        }
      };
      try {
        options?.onRequestStart?.({ messageCount: wireMessages.length, tools: requestTools });
      } catch {
        // Observation must not interrupt the model request.
      }
      // 中止也要有一条 request:end：否则「开了没结束」既可能是被中断、也可能是崩了。
      const onAbort = () => finishRequest({ outcome: 'aborted' });
      options?.signal?.addEventListener?.('abort', onAbort, { once: true });

      // krill 等上游在过载时返回 HTTP 200 + {"error":...,"type":"error"} JSON，
      // openai-node SDK 不会在 create() 抛错，而是把错误体反序列化成 APIError
      // 在流迭代首帧抛出（type=service_unavailable_error / code=server_is_overloaded）。
      // Tool calls remain buffered until success. Text always streams immediately;
      // retry after text only when the caller can restore its checkpoint.
      const canRollbackText = !!this.onTextAttemptStart && !!this.onTextRollback;
      let attemptHadToolOutput = false;
      // 失败也要有一条 request:end（outcome:'error'），口径与 Chat Completions 一致。
      const failed = await withRetry(
        async () => {
          emittedContentSeparator = false;
          attemptHadToolOutput = false;
          content = '';
          if (canRollbackText) this.onTextAttemptStart?.();
          completedResponse = undefined;
          outputItems = [];
          toolCalls = new Map<number, PendingToolCall>();
          hasReasoningText = false;
          reasoningParts = new ResponsesReasoningParts(
            (text) => {
              hasReasoningText = true;
              this.onThinking?.(text);
            },
            () => this.onThinkingCheckpoint?.('part'),
            () => throwIfQueryStopped(options),
          );
          const stream = await sendWithEffortFallback({
            provider: this.provider,
            model: this.model,
            effort: this.effort,
            params: this.reasoningParams,
            send: (reasoning) =>
              getClient(this).responses.create(
                {
                  model: this.model,
                  instructions: systemPrompt,
                  input: wireMessages,
                  ...(requestTools
                    ? {
                        tools: requestTools,
                        tool_choice: 'auto' as const,
                      }
                    : {}),
                  ...reasoning,
                  stream: true,
                },
                { signal: options?.signal },
              ),
          });

          // 上游可能握手成功后长时间不吐事件；空闲超过 60s 按超时处理并重试。
          for await (const event of withIdleTimeout(stream)) {
            throwIfQueryStopped(options);
            if (RESPONSE_TERMINAL_ERROR_TYPES.has(event.type)) throw responseEventError(event);

            if (event.type === 'response.output_text.delta') {
              // 首字只认正文/思考增量：response.created 之类的事件不算首字。
              if (!firstDeltaAt) firstDeltaAt = Date.now();
              const textDelta: string =
                contentSeparator && !emittedContentSeparator ? `${contentSeparator}${event.delta}` : event.delta;
              emittedContentSeparator = true;
              content += textDelta;
              this.onText?.(textDelta);
              continue;
            }

            if (
              event.type === 'response.reasoning_summary_text.delta' ||
              event.type === 'response.reasoning_text.delta' ||
              event.type === 'response.reasoning_summary_text.done' ||
              event.type === 'response.reasoning_text.done'
            ) {
              if (!firstDeltaAt) firstDeltaAt = Date.now();
              reasoningParts.accept(event);
              continue;
            }

            if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
              attemptHadToolOutput = true;
              toolCalls.set(event.output_index, {
                id: event.item.id,
                callId: event.item.call_id,
                name: event.item.name,
                arguments: event.item.arguments || '',
              });
              continue;
            }

            if (event.type === 'response.function_call_arguments.delta') {
              attemptHadToolOutput = true;
              const pending = toolCalls.get(event.output_index);
              if (pending) pending.arguments += event.delta;
              continue;
            }

            if (event.type === 'response.function_call_arguments.done') {
              attemptHadToolOutput = true;
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
                  const text = contentSeparator && !emittedContentSeparator ? `${contentSeparator}${finalText}` : finalText;
                  emittedContentSeparator = true;
                  content = text;
                  this.onText?.(text);
                }
              } else if (event.item.type === 'function_call') {
                attemptHadToolOutput = true;
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
              if (event.response?.status && event.response.status !== 'completed') {
                throw new Error(`Response completed with status: ${event.response.status}`);
              }
              completedResponse = event.response;
            }
          }
          throwIfQueryStopped(options);
          if (!completedResponse) {
            throw errorWithCode('Response stream ended before completion', 'ECONNRESET');
          }
        },
        {
          signal: options?.signal,
          maxRetries: 5,
          delayMs: 2000,
          backoffFactor: 2,
          maxDelayMs: 30000,
          shouldRetry: (error) => (!hasReasoningText || (canRollbackText && this.canRollbackThinking)) && (canRollbackText || (!content && !attemptHadToolOutput)) && isRetryableError(error),
          onRetry: ({ attempt, error, delayMs }) => {
            requestAttempts += 1;
            firstDeltaAt = 0;
            if (canRollbackText && (content || hasReasoningText)) this.onTextRollback?.();
            console.error(
              `[mica] provider request retry ${attempt}: ${error instanceof Error ? error.message : String(error)}`,
            );
            options?.onRetry?.({ attempt, error, delayMs });
          },
        },
      ).then(
        () => null,
        (error: unknown) => ({ error }),
      );

      if (failed) {
        options?.signal?.removeEventListener?.('abort', onAbort);
        finishRequest({
          outcome: options?.signal?.aborted ? 'aborted' : 'error',
          error: failed.error,
        });
        throw failed.error;
      }

      // Same guard as ChatCompletionsClient: the SDK ends the stream normally
      // when the request is aborted while waiting for the next event, so an
      // aborted turn must not be committed as a partial/empty response.
      throwIfQueryStopped(options);
      options?.signal?.removeEventListener?.('abort', onAbort);
      finishRequest({ outcome: 'completed', toolCalls: toolCalls.size });
      // A terminal event alone is not enough: the stream must also end cleanly.
      // This is a display boundary only; it does not change the request history.
      if (reasoningParts?.canCheckpointRequest) this.onThinkingCheckpoint?.('request');

      if (content) {
        totalContent += content;
        hasStreamedText = true;
        streamTextEndsWithBlankLine = totalContent.endsWith('\n\n');
      }

      if (completedResponse?.usage) {
        this.recordUsage(completedResponse.usage, {
          model: completedResponse.model,
          turnId,
          requestIndex,
          messageCount: messages.length,
        });
      }

      messages.push(...outputItems.filter((item) => !isEmptyResponseMessage(item)));
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

      const outcomes = await executeProviderToolCalls({
        calls: completedToolCalls.map((toolCall) => ({
          name: toolCall.name,
          argsText: toolCall.arguments,
          id: toolCall.callId,
          parseArgs: () => JSON.parse(toolCall.arguments || '{}'),
        })),
        signal: options?.signal,
        context: this.toolContext,
        toolFilter: this.toolFilter,
        onToolCall: this.onToolCall,
        onToolResult: this.onToolResult,
        checkpoint: () => throwIfQueryStopped(options),
      });
      for (const { id, result, images } of outcomes) {
        messages.push({
          type: 'function_call_output',
          call_id: id ?? '',
          output: responsesToolOutput(result, images),
        });
      }

      await commitCompleteIteration(true);
    }
  }

  private get reasoningParams(): Record<string, unknown> {
    return withResponsesReasoningSummary(
      resolveEffortParams({
        provider: this.provider,
        model: this.model,
        effort: this.effort,
        protocol: 'openai_responses',
      }),
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
      usageId: randomUUID(),
      occurredAt: new Date().toISOString(),
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
  if (typeof content === 'string') return [{ type: 'input_text', text: toWellFormedText(content) }];

  return content.map((part) => {
    if (part.type === 'text') return { type: 'input_text', text: toWellFormedText(part.text) };
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
  const safeText = toWellFormedText(text);
  if (images.length === 0) return safeText;
  return [
    { type: 'input_text', text: safeText },
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

/**
 * Output items echoed back from a previous response carry server-side-only
 * metadata (`status`, `id`, `phase`) that strict Responses-compatible gateways
 * reject inside the `input` array (krill: 400 [ObjectParam] [input[2].status]
 * [unknown_parameter]). Normalize everything that goes back on the wire to the
 * canonical input shapes; OpenAI tolerates the extra fields, strict gateways do
 * not.
 */
function toWireResponsesInput(messages: ResponseInputItem[]): ResponseInputItem[] {
  return messages.map(normalizeResponsesInputItem);
}

function normalizeResponsesInputItem(item: ResponseInputItem): ResponseInputItem {
  if (item.type === 'message') {
    return { type: 'message', role: item.role, content: item.content } as ResponseInputItem;
  }
  if (item.type === 'function_call') {
    return {
      type: 'function_call',
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments,
    } as ResponseInputItem;
  }
  if (item.type === 'function_call_output') {
    return { type: 'function_call_output', call_id: item.call_id, output: item.output } as ResponseInputItem;
  }
  if (item.type === 'reasoning') {
    // Strict Responses-compatible gateways validate the item id prefix against
    // the concrete item type: reasoning ids must begin with `rs_`. A foreign
    // provider may echo back a generically-prefixed or UUID id, which the
    // gateway then rejects with invalid_id_prefix. Only carry a valid id
    // through; drop the server-side-only field otherwise (mirrors how the
    // `message` branch strips `status`/`id`/`phase`).
    return {
      type: 'reasoning',
      ...(item.id && item.id.startsWith('rs_') ? { id: item.id } : {}),
      summary: item.summary,
      ...(item.content ? { content: item.content } : {}),
      ...(item.encrypted_content ? { encrypted_content: item.encrypted_content } : {}),
    } as ResponseInputItem;
  }
  return item;
}

function isEmptyResponseMessage(item: ResponseInputItem): boolean {
  return item.type === 'message' && item.role === 'assistant' && item.content.length === 0;
}

function repairResponsesToolResults(messages: ResponseInputItem[]): ResponseInputItem[] {
  const repaired: ResponseInputItem[] = [];
  const pending = new Set<string>();
  for (const item of messages) {
    if (item.type === 'message' && pending.size > 0) {
      repaired.push(...Array.from(pending, interruptedResponsesToolResult));
      pending.clear();
    }

    if (item.type === 'function_call_output') {
      // A valid output must correspond to a pending function call. Dropping
      // orphaned/duplicate outputs repairs older interrupted snapshots.
      if (pending.delete(item.call_id)) repaired.push(item);
      continue;
    }

    repaired.push(item);
    if (item.type === 'function_call' && item.call_id) pending.add(item.call_id);
  }

  if (pending.size > 0) repaired.push(...Array.from(pending, interruptedResponsesToolResult));
  return repaired;
}

function prepareHistoricalResponsesInput(messages: ResponseInputItem[]): ResponseInputItem[] {
  return stripUnusableResponseInputItems(messages).map((rawItem) => {
    const item = sanitizeHistoricalResponsesText(
      sanitizeHistoricalResponsesMedia(normalizeResponsesInputItem(rawItem)),
    );
    if (item.type !== 'function_call_output' || typeof item.output !== 'string') return item;
    const compacted = compactHistoricalToolResultText(item.output);
    return compacted === item.output ? item : { ...item, output: compacted };
  });
}

function sanitizeHistoricalResponsesText(item: ResponseInputItem): ResponseInputItem {
  if (item.type === 'message' && typeof item.content === 'string') {
    const content = toWellFormedText(item.content);
    return content === item.content ? item : { ...item, content };
  }
  if (item.type === 'message' && Array.isArray(item.content)) {
    const content = item.content.map((part) => sanitizeResponsesTextPart(part));
    return { ...item, content } as ResponseInputItem;
  }
  if (item.type === 'function_call' && typeof item.arguments === 'string') {
    const args = toWellFormedText(item.arguments);
    return args === item.arguments ? item : { ...item, arguments: args };
  }
  if (item.type === 'function_call_output' && typeof item.output === 'string') {
    const output = toWellFormedText(item.output);
    return output === item.output ? item : { ...item, output };
  }
  if (item.type === 'function_call_output' && Array.isArray(item.output)) {
    const output = item.output.map((part) => sanitizeResponsesTextPart(part));
    return { ...item, output } as ResponseInputItem;
  }
  return item;
}

function sanitizeResponsesTextPart<T>(part: T): T {
  if (!part || typeof part !== 'object') return part;
  const record = part as Record<string, unknown>;
  const textKey = typeof record.text === 'string' ? 'text' : typeof record.refusal === 'string' ? 'refusal' : null;
  if (!textKey) return part;
  const text = toWellFormedText(record[textKey] as string);
  return text === record[textKey] ? part : ({ ...record, [textKey]: text } as T);
}

function sanitizeHistoricalResponsesMedia(item: ResponseInputItem): ResponseInputItem {
  if (item.type === 'message' && Array.isArray(item.content)) {
    const replacementType = item.role === 'assistant' ? 'output_text' : 'input_text';
    const content = item.content.map((part) => sanitizeResponsesImagePart(part, replacementType));
    return { ...item, content } as ResponseInputItem;
  }
  if (item.type === 'function_call_output' && Array.isArray(item.output)) {
    const output = item.output.map((part) => sanitizeResponsesImagePart(part, 'input_text'));
    return { ...item, output } as ResponseInputItem;
  }
  return item;
}

function sanitizeResponsesImagePart<T>(
  part: T,
  replacementType: 'input_text' | 'output_text',
): T | { type: 'input_text'; text: string } | { type: 'output_text'; text: string; annotations: [] } {
  if (!part || typeof part !== 'object') return part;
  const record = part as Record<string, unknown>;
  if (
    record.type !== 'input_image' ||
    isValidHistoricalImageUrl(record.image_url) ||
    (typeof record.file_id === 'string' && record.file_id.trim().length > 0)
  ) {
    return part;
  }
  const text = '[image omitted from invalid historical content]';
  return replacementType === 'output_text'
    ? { type: 'output_text', text, annotations: [] }
    : { type: 'input_text', text };
}

function isValidHistoricalImageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (/^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value)) return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function toWellFormedText(text: string): string {
  let result = '';
  let changed = false;

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += text[index] + text[index + 1];
        index++;
      } else {
        result += '\ufffd';
        changed = true;
      }
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      result += '\ufffd';
      changed = true;
      continue;
    }

    result += text[index];
  }

  return changed ? result : text;
}

function stripUnusableResponseInputItems(messages: ResponseInputItem[]): ResponseInputItem[] {
  return messages.filter((item) => item.type !== 'reasoning' || Boolean(item.encrypted_content));
}

/**
 * 发送前整条丢弃历史 reasoning。
 *
 * 上游会把回放的 reasoning 按完整思考内容计入 input tokens：同一份历史带上
 * reasoning 时报 391K，去掉后只报 99K（DeepSeek `/responses` 实测），而 reasoning
 * 在长任务的会话里占到历史体积的三分之二。模型并不需要上一轮的原始思考——丢掉后
 * 会针对当前上下文重新推理，这也是 compact 剥掉 encrypted_content 后走同一条路径的
 * 既有行为。
 *
 * 只作用于发送副本：`this.messages` 与 session 持久化仍保留 reasoning，UI 的
 * thinking 展示不受影响（落盘侧由 stripUnusableResponseInputItems 决定）。
 */
function dropReplayedReasoningItems(messages: ResponseInputItem[]): ResponseInputItem[] {
  return messages.filter((item) => item.type !== 'reasoning');
}

/**
 * Replaces every image part with a text placeholder before a request goes to a
 * model that cannot accept images. Works on a copy: the persisted conversation
 * keeps the original image blocks so switching back to a vision model does not
 * lose them.
 */
function stripImagesForVision(
  messages: ResponseInputItem[],
  supportsVision: boolean,
  model: string,
): ResponseInputItem[] {
  if (supportsVision) return messages;
  const placeholder = imageOmittedPlaceholder(model);
  return messages.map((item) => {
    if (item.type === 'message' && Array.isArray(item.content)) {
      const content = item.content.map((part) =>
        part.type === 'input_image' ? { type: 'input_text' as const, text: placeholder } : part,
      );
      return { ...item, content } as ResponseInputItem;
    }
    if (item.type === 'function_call_output' && Array.isArray(item.output)) {
      const output = item.output.map((part) =>
        part.type === 'input_image' ? { type: 'input_text' as const, text: placeholder } : part,
      );
      return { ...item, output } as ResponseInputItem;
    }
    return item;
  });
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
