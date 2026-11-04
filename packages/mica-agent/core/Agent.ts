import type { AgentConversationMessage, AgentQueryContent } from './Content.js';

export type AgentUsageRecord = {
  /** Stable identity for one model response. Preserved when snapshots are copied or forked. */
  usageId?: string;
  /** UTC wall-clock time when the provider reported this usage. */
  occurredAt?: string;
  provider: string;
  turnId: number;
  requestIndex: number;
  messageCount: number;
  model?: string;
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  totalTokens: number;
  paidTokenRate: number;
};

export type AgentCallbacks = {
  onText?: (text: string) => void;
  /** Checkpoint and restore visible text around a retried request. */
  onTextAttemptStart?: () => void;
  onTextRollback?: () => void;
  /** The attempt rollback callback also restores every thinking consumer. */
  canRollbackThinking?: boolean;
  onThinking?: (thinking: string) => void;
  /** Save a complete Responses thinking part or completed request for display. */
  onThinkingCheckpoint?: (boundary: 'part' | 'request') => void;
  onToolCall?: (name: string, args: string, id?: string) => void;
  onToolResult?: (name: string, result: string, id?: string) => void;
  onUsage?: (usage: AgentUsageRecord) => void;
};

export type AgentQueryOptions = {
  signal?: AbortSignal;
  shouldContinue?: () => boolean;
  /**
   * 在「上一次请求的产物已落定、下一次请求尚未发出」的边界上返回 true 时停下，
   * 抛 `AgentPausedError`。宿主重启前的软停用它：此刻历史尾部是完整的（工具结果
   * 已提交），重启后重新发一次请求就能接着跑，不必重做已经做完的工具调用。
   *
   * 只在迭代边界求值；正在等模型或正在跑工具时不会被打断——那种情况由调用方在
   * 自己的超时预算用尽后 abort。
   */
  shouldPause?: () => boolean;
  /**
   * 不追加 `question`，直接对现有历史发请求。宿主重启后接续一轮被暂停的运行时
   * 用它：历史尾部已经是完整的工具批次，再补一条用户消息就等于凭空多一句话。
   */
  resume?: boolean;
  /** Once before each model request, excluding transport retries. Observer errors are ignored. */
  onRequestStart?: (info: { messageCount: number; tools?: unknown }) => void;
  /**
   * 一次模型请求真正结束（成功或失败）时调用一次，成对的 `onRequestStart`。
   *
   * 用于回答「这一轮的时间花在哪」：`durationMs` 覆盖建流 + 流消费（含传输层重试），
   * `firstTokenMs` 是首个正文/思考增量到达的时刻（排队 + 首字延迟，用户感知的「多久
   * 才动起来」），`attempts` 含重试次数。观察方抛错不影响请求。
   */
  onRequestEnd?: (info: {
    durationMs: number;
    firstTokenMs?: number;
    attempts: number;
    outcome: 'completed' | 'error' | 'aborted';
    toolCalls?: number;
    error?: string;
  }) => void;
  onIterationComplete?: () => AgentQueryContent | null | undefined | Promise<AgentQueryContent | null | undefined>;
  /**
   * Rewrites in-flight session messages immediately before each model request,
   * including the first request and any input queued after a tool iteration.
   * It does not run after a final answer or before a rejected maxTurns/abort guard.
   *
   * The loop keeps its own message array, so rewriting the client's snapshot
   * mid-query would NOT affect the rest of the turn; this hook is the only place
   * where a context-reducing rewrite (e.g. automatic compaction) can shrink the
   * next request. Receives the session messages without the system prompt
   * (protocol-agnostic shape, same as `getSnapshot().messages`) and returns the
   * list to continue with; returning null keeps the current messages.
   */
  rewriteIterationMessages?: (
    messages: unknown[],
  ) => unknown[] | null | undefined | Promise<unknown[] | null | undefined>;
  /** Maximum number of model requests in one agentic query, including the initial request. */
  maxTurns?: number;
  /** Provider-level retry progress. Used to surface
   *  retrying to the caller (e.g. a `retrying` working status in the UI). */
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
};

export class AgentMaxTurnsError extends Error {
  constructor(
    readonly maxTurns: number,
    readonly partialResult: string,
  ) {
    super(`Agent reached the maximum of ${maxTurns} turns before completing the task.`);
    this.name = 'AgentMaxTurnsError';
  }
}

/** 迭代边界上的软停顿，见 {@link AgentQueryOptions.shouldPause}。不是失败。 */
export class AgentPausedError extends Error {
  constructor() {
    super('Agent paused at an iteration boundary before the next model request.');
    this.name = 'AgentPausedError';
  }
}

export function throwIfTurnPaused(options: AgentQueryOptions | undefined): void {
  if (options?.shouldPause?.()) throw new AgentPausedError();
}

export function throwIfAgentMaxTurnsReached(
  options: AgentQueryOptions | undefined,
  completedTurns: number,
  partialResult: string,
): void {
  const maxTurns = options?.maxTurns;
  if (maxTurns === undefined) return;
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
    throw new Error(`maxTurns must be a positive integer, received ${String(maxTurns)}.`);
  }
  if (completedTurns >= maxTurns) {
    throw new AgentMaxTurnsError(maxTurns, partialResult);
  }
}

export type AgentSnapshot<TMessage = unknown, TUsage extends AgentUsageRecord = AgentUsageRecord> = {
  model: string;
  messages: TMessage[];
  usageHistory: TUsage[];
  lastUsage: TUsage | undefined;
  conversationMessages: AgentConversationMessage[];
};

export interface IAgent<
  TOptions = unknown,
  TMessage = unknown,
  TUsage extends AgentUsageRecord = AgentUsageRecord,
> extends AgentCallbacks {
  model: string;
  messages: TMessage[];
  usageHistory: TUsage[];
  lastUsage: TUsage | undefined;

  configure(options: TOptions): void;
  reset(): void;
  query(question: AgentQueryContent, options?: AgentQueryOptions): Promise<string>;
  preserveAbortedTurn(question: AgentQueryContent, partialAnswer?: string): boolean;
  toConversationMessages(): AgentConversationMessage[];
  getSnapshot(): AgentSnapshot<TMessage, TUsage>;
  loadSnapshot(snapshot: AgentSnapshot<TMessage, TUsage>): void;
}

export abstract class BaseAgent<
  TOptions,
  TMessage,
  TUsage extends AgentUsageRecord = AgentUsageRecord,
> implements IAgent<TOptions, TMessage, TUsage> {
  abstract model: string;
  abstract messages: TMessage[];
  abstract usageHistory: TUsage[];
  abstract lastUsage: TUsage | undefined;

  onText: ((text: string) => void) | undefined;
  onTextAttemptStart: (() => void) | undefined;
  onTextRollback: (() => void) | undefined;
  canRollbackThinking = false;
  onThinking: ((thinking: string) => void) | undefined;
  onThinkingCheckpoint: ((boundary: 'part' | 'request') => void) | undefined;
  onToolCall: ((name: string, args: string, id?: string) => void) | undefined;
  onToolResult: ((name: string, result: string, id?: string) => void) | undefined;
  onUsage: ((usage: AgentUsageRecord) => void) | undefined;

  abstract configure(options: TOptions): void;
  abstract reset(): void;
  abstract query(question: AgentQueryContent, options?: AgentQueryOptions): Promise<string>;
  abstract preserveAbortedTurn(question: AgentQueryContent, partialAnswer?: string): boolean;
  abstract toConversationMessages(): AgentConversationMessage[];
  abstract loadSnapshot(snapshot: AgentSnapshot<TMessage, TUsage>): void;

  getSnapshot(): AgentSnapshot<TMessage, TUsage> {
    return {
      model: this.model,
      messages: this.messages,
      usageHistory: this.usageHistory,
      lastUsage: this.lastUsage,
      conversationMessages: this.toConversationMessages(),
    };
  }

  protected loadSnapshotState(
    snapshot: AgentSnapshot<TMessage, TUsage>,
    filterMessage?: (message: TMessage) => boolean,
  ): number {
    this.messages = filterMessage ? snapshot.messages.filter(filterMessage) : snapshot.messages;
    this.usageHistory = snapshot.usageHistory;
    this.lastUsage = snapshot.lastUsage;
    return this.usageHistory.reduce((max, usage) => Math.max(max, usage.turnId), 0);
  }
}

export type { AgentContentBlockParam, AgentConversationMessage, AgentQueryContent } from './Content.js';
