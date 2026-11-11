import { randomUUID } from 'node:crypto';
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  Tool,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai';
import { micaTools } from '@packages/mica-tools/index.js';
import { resolveEffortParams } from '@packages/mica-config/index.js';
import { PI_MESSAGE_FORMAT, PI_MESSAGE_FORMAT_ERROR } from '@packages/mica-common/messageFormat.js';
import { sameSessionUserContent } from '@packages/mica-common/sessionMessages.js';
import {
  BaseAgent,
  throwIfAgentMaxTurnsReached,
  type AgentConversationMessage,
  type AgentQueryContent,
  type AgentQueryOptions,
  type AgentSnapshot,
  type AgentUsageRecord,
} from '../core/Agent.js';
import { abortError, isRetryableError, withRetry } from '../core/retry.js';
import { withIdleTimeout } from '../core/streamIdleTimeout.js';
import { buildSystemPrompt } from '../prompt/index.js';
import { compactHistoricalToolResultText } from './historyCompaction.js';
import { markProviderOmitsFinishReason } from './finishReasonSupport.js';
import { sendWithEffortFallback } from './effortFallback.js';
import { executeProviderToolCalls, throwIfQueryStopped } from './providerHelpers.js';
import { applyImageBudget, describeImageBudget } from './imageBudget.js';
import { observeGenerationText, sampleGenerationTiming, type GenerationTiming } from './generationTiming.js';
import { piModel, streamPiRequest } from './piTransport.js';
import { PiThinkingDisplay } from './PiThinkingDisplay.js';
import type { ModelClientOptions } from './types.js';

export { PI_MESSAGE_FORMAT };

/** One product loop; Pi supplies protocol conversion, reasoning replay, stream parsing and tool argument assembly. */
export class PiModelClient extends BaseAgent<ModelClientOptions, Message, AgentUsageRecord> {
  messages: Message[] = [];
  usageHistory: AgentUsageRecord[] = [];
  lastUsage: AgentUsageRecord | undefined;
  model!: string;
  private settings!: ModelClientOptions;
  private turnId = 0;
  private turnCommitted = false;

  constructor(options: ModelClientOptions) {
    super();
    this.configure(options);
  }

  configure(options: ModelClientOptions): void {
    this.settings = { ...options };
    this.model = options.model;
  }
  get effort() {
    return this.settings.effort;
  }
  get provider() {
    return this.settings.provider;
  }
  get tools() {
    return this.settings.tools ?? true;
  }
  get toolFilter() {
    return this.settings.toolFilter;
  }
  set toolFilter(value: ModelClientOptions['toolFilter']) {
    this.settings.toolFilter = value;
  }

  reset(): void {
    this.messages = [];
    this.usageHistory = [];
    this.lastUsage = undefined;
    this.turnId = 0;
    this.turnCommitted = false;
  }

  override getSnapshot(options: { includeConversation?: boolean } = {}): AgentSnapshot<Message> {
    return { ...super.getSnapshot(options), messageFormat: PI_MESSAGE_FORMAT };
  }

  loadSnapshot(snapshot: AgentSnapshot<Message>): void {
    if (snapshot.messageFormat !== PI_MESSAGE_FORMAT && snapshot.messages.length)
      throw new Error(PI_MESSAGE_FORMAT_ERROR);
    this.turnCommitted = false;
    this.turnId = this.loadSnapshotState({ ...snapshot, messages: prepareHistory(snapshot.messages) });
  }

  toConversationMessages(): AgentConversationMessage[] {
    return this.messages.flatMap((message): AgentConversationMessage[] => {
      if (message.role !== 'user' && message.role !== 'assistant') return [];
      if (typeof message.content === 'string')
        return message.content ? [{ role: message.role, content: message.content }] : [];
      const content = message.content
        .flatMap((part) => (part.type === 'text' ? [part.text] : part.type === 'image' ? ['[Image]'] : []))
        .join('');
      return content ? [{ role: message.role, content }] : [];
    });
  }

  preserveAbortedTurn(question: AgentQueryContent, partialAnswer?: string): boolean {
    this.messages = prepareHistory(this.messages);
    const user = userMessage(question);
    const tail = this.messages.at(-1);
    // 按正文判定「这一问已经在历史里」，而不是逐字节比较块结构：迁移过来的图片块
    // 字段顺序与新建的不同，快速压缩又把图片换成了占位文本，两者都还是同一问。
    const alreadyPresent =
      this.turnCommitted || (tail?.role === 'user' && sameSessionUserContent(tail.content, user.content));
    if (!alreadyPresent) this.messages.push(user);
    if (partialAnswer?.trim()) this.messages.push(this.textMessage(partialAnswer.trim()));
    return alreadyPresent;
  }

  async query(question: AgentQueryContent, options?: AgentQueryOptions): Promise<string> {
    const turnId = ++this.turnId;
    this.turnCommitted = false;
    // Freeze controls for the turn; tool registries are snapshotted separately for each request.
    const settings = { ...this.settings };
    const prompt =
      typeof settings.systemPrompt === 'function'
        ? settings.systemPrompt()
        : (settings.systemPrompt ?? buildSystemPrompt());
    let messages = [...prepareHistory(this.messages), userMessage(question)];
    let requestIndex = 0;
    let totalContent = '';
    let endsWithBlankLine = false;
    let hasThinkingOutput = false;

    const commit = async (takeInput: boolean): Promise<void> => {
      this.messages = takeInput ? messages.slice() : prepareHistory(messages);
      this.turnCommitted = true;
      if (!takeInput) return;
      const input = await options?.onIterationComplete?.();
      throwIfQueryStopped(options);
      if (input !== null && input !== undefined) messages.push(userMessage(input));
    };

    while (true) {
      throwIfQueryStopped(options);
      throwIfAgentMaxTurnsReached(options, requestIndex, totalContent);
      if (options?.rewriteIterationMessages) {
        const rewritten = await options.rewriteIterationMessages(messages);
        throwIfQueryStopped(options);
        if (Array.isArray(rewritten)) {
          messages = rewritten as Message[];
          this.messages = messages.slice();
          this.turnCommitted = true;
        }
      }
      requestIndex++;
      const model = piModel(settings);
      const budgeted = applyImageBudget(messages);
      const note = describeImageBudget(budgeted.report);
      if (note) console.error(note);
      const requestTools: Tool[] | undefined =
        settings.tools === false
          ? undefined
          : micaTools.getDefinitions(settings.toolFilter).map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.input_schema as Tool['parameters'],
            }));
      const context = { systemPrompt: prompt, messages: budgeted.value, tools: requestTools };
      const startedAt = Date.now();
      let attemptStartedAt = startedAt;
      let firstDeltaAt = 0;
      let attempts = 1;
      let startSent = false;
      let endSent = false;
      let hadOutput = false;
      let hadThinking = false;
      let missingFinishReasons = 0;
      let timing: GenerationTiming = { textDeltaCount: 0, hasOtherOutput: false };
      let generationReasoningTokens: number | undefined;
      const totalCheckpoint = totalContent;
      const blankCheckpoint = endsWithBlankLine;
      const thinkingCheckpoint = hasThinkingOutput;
      const rollback = !!this.onTextAttemptStart && !!this.onTextRollback;
      let response: AssistantMessage;
      let thinkingComplete = false;

      const finish = (outcome: 'completed' | 'error' | 'aborted', error?: unknown, toolCalls?: number): void => {
        if (!startSent || endSent) return;
        endSent = true;
        observe(() =>
          options?.onRequestEnd?.({
            durationMs: Date.now() - startedAt,
            firstTokenMs: firstDeltaAt ? firstDeltaAt - attemptStartedAt : undefined,
            attempts,
            outcome,
            toolCalls,
            error: error === undefined ? undefined : errorText(error).slice(0, 200),
          }),
        );
      };
      const onAbort = () => finish('aborted');
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        response = await withRetry(
          async () => {
            attemptStartedAt = Date.now();
            firstDeltaAt = 0;
            hadOutput = false;
            hadThinking = false;
            timing = { textDeltaCount: 0, hasOtherOutput: false };
            generationReasoningTokens = undefined;
            if (rollback) this.onTextAttemptStart?.();
            return sendWithEffortFallback({
              provider: settings.provider,
              model: settings.model,
              effort: settings.effort,
              params: resolveEffortParams({
                provider: settings.provider,
                model: settings.model,
                effort: settings.effort,
                protocol: settings.provider.protocol,
              }),
              shouldFallback: () => !hadOutput && !hadThinking,
              send: async (reasoning) => {
                const controller = new AbortController();
                const signal = options?.signal
                  ? AbortSignal.any([options.signal, controller.signal])
                  : controller.signal;
                let transportError: unknown;
                let terminal: AssistantMessage | undefined;
                let textStarted = false;
                let thinkingStarted = false;
                const textParts = new Map<number, string>();
                const emitText = (index: number, delta: string): void => {
                  if (!delta) return;
                  if (!firstDeltaAt) firstDeltaAt = Date.now();
                  observeGenerationText(timing, delta);
                  hadOutput = true;
                  textParts.set(index, (textParts.get(index) ?? '') + delta);
                  const separator = !textStarted && totalContent && !endsWithBlankLine ? '\n\n' : '';
                  textStarted = true;
                  totalContent += separator + delta;
                  endsWithBlankLine = totalContent.endsWith('\n\n');
                  this.onText?.(separator + delta);
                };
                const thinking = new PiThinkingDisplay(
                  (delta) => {
                    if (delta && !firstDeltaAt) firstDeltaAt = Date.now();
                    hadThinking ||= !!delta;
                    if (!thinkingStarted && hasThinkingOutput) this.onThinking?.('\n\n');
                    thinkingStarted = true;
                    hasThinkingOutput = true;
                    this.onThinking?.(delta);
                  },
                  () => this.onThinkingCheckpoint?.('part'),
                  () => throwIfQueryStopped(options),
                );
                const streams = streamPiRequest({
                  model,
                  context,
                  options: settings,
                  reasoning,
                  signal,
                  onTransportError(error) {
                    transportError = error;
                  },
                  onGenerationMetadata(info) {
                    generationReasoningTokens = info.reasoningTokens ?? generationReasoningTokens;
                    timing.hasOtherOutput ||= info.hasOtherOutput;
                  },
                  onPayload(payload) {
                    if (startSent) return;
                    startSent = true;
                    const history = payload.messages ?? payload.input ?? payload.contents;
                    observe(() =>
                      options?.onRequestStart?.({
                        messageCount: Array.isArray(history) ? history.length : messages.length,
                        tools: payload.tools ?? (payload.config as { tools?: unknown } | undefined)?.tools,
                      }),
                    );
                  },
                });
                try {
                  for await (const event of withIdleTimeout(streams, { signal })) {
                    throwIfQueryStopped(options);
                    if (event.type === 'text_delta' && event.delta) {
                      emitText(event.contentIndex, event.delta);
                    } else if (event.type === 'thinking_start') {
                      thinking.start(event.contentIndex);
                    } else if (event.type === 'thinking_delta' && event.delta) {
                      if (!firstDeltaAt) firstDeltaAt = Date.now();
                      hadThinking = true;
                      thinking.delta(event.contentIndex, event.delta);
                    } else if (event.type === 'thinking_end') {
                      thinking.end(event.contentIndex, event.content);
                    } else if (event.type === 'text_end') {
                      const emitted = textParts.get(event.contentIndex) ?? '';
                      if (event.content.startsWith(emitted))
                        emitText(event.contentIndex, event.content.slice(emitted.length));
                    } else if (
                      event.type === 'toolcall_start' ||
                      event.type === 'toolcall_delta' ||
                      event.type === 'toolcall_end'
                    ) {
                      hadOutput = true;
                      timing.hasOtherOutput = true;
                      const call =
                        event.type === 'toolcall_end' ? event.toolCall : event.partial.content[event.contentIndex];
                      this.onToolInput?.({
                        phase:
                          event.type === 'toolcall_start' ? 'start' : event.type === 'toolcall_end' ? 'end' : 'delta',
                        index: event.contentIndex,
                        ...(call?.type === 'toolCall' ? { id: call.id, name: call.name } : {}),
                        ...(event.type === 'toolcall_delta' ? { delta: event.delta } : {}),
                      });
                    } else if (event.type === 'error') {
                      if (signal.aborted || event.reason === 'aborted') throw abortError();
                      const error = transportError ?? piError(event.error.errorMessage ?? 'Model request failed');
                      if (
                        /without finish_reason/i.test(errorText(error)) &&
                        ++missingFinishReasons > 1 &&
                        model.api === 'openai-completions'
                      ) {
                        markProviderOmitsFinishReason(settings.provider, settings.model);
                        model.compat = { ...model.compat, supportsFinishReason: false };
                        // Re-use the complete parsed response; never reconstruct tool arguments ourselves.
                        terminal = {
                          ...event.error,
                          stopReason: event.error.content.some((part) => part.type === 'toolCall') ? 'toolUse' : 'stop',
                        };
                        delete terminal.errorMessage;
                      } else throw error;
                    } else if (event.type === 'done') terminal = event.message;
                  }
                  throwIfQueryStopped(options);
                  if (!terminal) throw piError('Model stream ended without a terminal event');
                  if (terminal.stopReason === 'deferred' || terminal.stopReason === 'pending')
                    throw new Error('Deferred model responses are not supported.');
                  thinkingComplete = thinking.complete;
                  return terminal;
                } finally {
                  // Pi produces in the background; closing our iterator alone does not stop the request.
                  controller.abort();
                }
              },
            });
          },
          {
            signal: options?.signal,
            maxRetries: 5,
            delayMs: 2000,
            backoffFactor: 2,
            maxDelayMs: 30_000,
            shouldRetry: (error) =>
              (rollback ? !hadThinking || this.canRollbackThinking : !hadOutput && !hadThinking) &&
              isRetryableError(error),
            onRetry: (info) => {
              attempts++;
              if (rollback && (hadOutput || hadThinking)) this.onTextRollback?.();
              totalContent = totalCheckpoint;
              endsWithBlankLine = blankCheckpoint;
              hasThinkingOutput = thinkingCheckpoint;
              options?.onRetry?.(info);
            },
          },
        );
      } catch (error) {
        finish(options?.signal?.aborted || (error as Error)?.name === 'AbortError' ? 'aborted' : 'error', error);
        throw error;
      } finally {
        options?.signal?.removeEventListener('abort', onAbort);
      }
      throwIfQueryStopped(options);
      const calls = response.content.filter((part): part is ToolCall => part.type === 'toolCall');
      finish('completed', undefined, calls.length);
      if (thinkingComplete) this.onThinkingCheckpoint?.('request');
      this.recordUsage(response, {
        turnId,
        requestIndex,
        messageCount: messages.length,
        durationMs: Date.now() - startedAt,
        firstTokenMs: firstDeltaAt ? firstDeltaAt - attemptStartedAt : undefined,
        responseWaitMs: firstDeltaAt ? firstDeltaAt - startedAt : undefined,
        ...sampleGenerationTiming(timing, response.usage.output, generationReasoningTokens),
      });
      if (response.stopReason === 'length' && calls.length) {
        throw new Error('Model output limit reached with incomplete tool calls; tools were not executed.');
      }
      if (response.content.length) messages.push(response);
      if (!calls.length) {
        await commit(false);
        return totalContent;
      }
      if (totalContent && !endsWithBlankLine) {
        totalContent += '\n\n';
        endsWithBlankLine = true;
        this.onText?.('\n\n');
      }
      const outcomes = await executeProviderToolCalls({
        calls: calls.map((call) => ({
          id: call.id,
          name: call.name,
          argsText: JSON.stringify(call.arguments),
          parseArgs: () => {
            if (call.argumentsError) throw new Error(call.argumentsError);
            return call.arguments;
          },
        })),
        signal: options?.signal,
        context: settings.toolContext,
        toolFilter: settings.toolFilter,
        onToolCall: this.onToolCall,
        onToolResult: this.onToolResult,
        checkpoint: () => throwIfQueryStopped(options),
      });
      for (const outcome of outcomes) {
        messages.push({
          role: 'toolResult',
          toolCallId: outcome.id ?? '',
          toolName: outcome.name,
          content: [
            { type: 'text', text: outcome.result },
            ...outcome.images.map(
              (image): ImageContent => ({
                type: 'image',
                data: image.source.data,
                mimeType: image.source.media_type,
              }),
            ),
          ],
          isError: outcome.isError,
          timestamp: Date.now(),
        });
      }
      await commit(true);
    }
  }

  private textMessage(text: string): AssistantMessage {
    return {
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: piModel(this.settings).api,
      provider: this.provider.id,
      model: this.model,
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    };
  }

  private recordUsage(
    response: AssistantMessage,
    metadata: Pick<
      AgentUsageRecord,
      | 'turnId'
      | 'requestIndex'
      | 'messageCount'
      | 'durationMs'
      | 'firstTokenMs'
      | 'responseWaitMs'
      | 'generationDurationMs'
      | 'generationOutputTokens'
    >,
  ): void {
    const usage = response.usage;
    if (!usage.totalTokens && !usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite) return;
    // Pi input excludes cache reads/writes; Mica's inputTokens includes all prompt tokens.
    const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    const totalTokens = usage.totalTokens || inputTokens + usage.output;
    const record: AgentUsageRecord = {
      usageId: randomUUID(),
      occurredAt: new Date().toISOString(),
      provider: this.provider.protocol,
      providerId: this.provider.id,
      model: response.responseModel ?? response.model,
      inputTokens,
      cachedInputTokens: usage.cacheRead,
      outputTokens: usage.output,
      totalTokens,
      paidTokenRate: totalTokens > 0 ? Math.max(0, totalTokens - usage.cacheRead) / totalTokens : 0,
      ...metadata,
    };
    this.lastUsage = record;
    this.usageHistory.push(record);
    this.onUsage?.(record);
  }
}

function userMessage(content: AgentQueryContent): Message {
  return {
    role: 'user',
    timestamp: Date.now(),
    content:
      typeof content === 'string'
        ? content
        : content.map((part): TextContent | ImageContent =>
            part.type === 'text' ? part : { type: 'image', data: part.source.data, mimeType: part.source.media_type },
          ),
  };
}

function prepareHistory(messages: Message[]): Message[] {
  // Pi synthesizes missing results. Persisted duplicate/orphan results must be removed
  // first: they cannot be paired by any provider and may follow an interrupted save.
  const pending = new Set<string>();
  return messages
    .filter((message) => {
      if (message.role === 'system') return false;
      if (message.role === 'assistant') {
        pending.clear();
        for (const part of message.content) if (part.type === 'toolCall') pending.add(part.id);
      } else if (message.role === 'user') pending.clear();
      else if (message.role === 'toolResult') return pending.delete(message.toolCallId);
      return true;
    })
    .map((message) => {
      if (message.role !== 'toolResult') return message;
      return {
        ...message,
        content: message.content.map((part) =>
          part.type === 'text' ? { ...part, text: compactHistoricalToolResultText(part.text) } : part,
        ),
      };
    });
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function observe(callback: () => void): void {
  try {
    callback();
  } catch {
    /* Observation cannot interrupt inference. */
  }
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function piError(message: string): Error {
  const error = new Error(message);
  const status = /\b([45]\d\d)\b/.exec(message);
  if (status) Object.assign(error, { status: Number(status[1]) });
  if (/stream ended (?:before|without)|without finish_reason/i.test(message))
    Object.assign(error, { code: 'ECONNRESET' });
  return error;
}
