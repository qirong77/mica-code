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
  onThinking?: (thinking: string) => void;
  onToolCall?: (name: string, args: string, id?: string) => void;
  onToolResult?: (name: string, result: string, id?: string) => void;
  onUsage?: (usage: AgentUsageRecord) => void;
};

export type AgentQueryOptions = {
  signal?: AbortSignal;
  shouldContinue?: () => boolean;
  onIterationComplete?: () => AgentQueryContent | null | undefined | Promise<AgentQueryContent | null | undefined>;
  /** Maximum number of model requests in one agentic query, including the initial request. */
  maxTurns?: number;
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
  onThinking: ((thinking: string) => void) | undefined;
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
