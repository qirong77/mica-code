import mitt from 'mitt';
import {
  micaAgent,
  type AgentQueryContent,
  type AgentSnapshot,
  type IAgent,
  type AgentUsageRecord,
  type ModelClientOptions,
} from '@packages/mica-agent/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import type { EffortOption } from '@packages/mica-config/index.js';
import {
  agentRuntimeConfigFromSnapshot,
  createAgentClientOptions,
  readAgentRuntimeConfig,
  type AgentRuntimeConfig,
} from './AgentRuntimeConfig.js';

export type AgentRuntimeStatus =
  | { type: 'idle' }
  | { type: 'connecting'; startedAt?: number; moduleStartedAt?: number }
  | { type: 'thinking'; startedAt?: number; moduleStartedAt?: number }
  | { type: 'streaming'; startedAt?: number; moduleStartedAt?: number }
  | { type: 'calling_tool'; startedAt?: number; moduleStartedAt?: number; toolNames?: string[] }
  | { type: 'completed'; startedAt?: number; elapsedMs?: number }
  | { type: 'error'; message: string };

export type AgentRuntimeEvents = {
  text: string;
  thinking: string;
  toolCall: { name: string; args: string; id?: string };
  toolResult: { name: string; result: string; id?: string };
  usage: AgentUsageRecord;
  status: AgentRuntimeStatus;
};

export type AgentRuntimeSnapshot = {
  providerId: string;
  model: string;
  effort: EffortOption;
  messages: AgentSnapshot<unknown, AgentUsageRecord>['messages'];
  usageHistory: AgentUsageRecord[];
  lastUsage: AgentUsageRecord | undefined;
};

type AgentRunOptions = {
  onIterationComplete?: () => AgentQueryContent | null | undefined | Promise<AgentQueryContent | null | undefined>;
};

export class AgentAbortError extends Error {
  constructor(readonly runId: number) {
    super('Agent run aborted');
    this.name = 'AgentAbortError';
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'AgentAbortError');
}

function contentToText(content: AgentQueryContent): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function dropLastUserMessageAndAfter<TMessage>(messages: TMessage[]): TMessage[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message && typeof message === 'object' && 'role' in message && message.role === 'user') {
      return messages.slice(0, index);
    }
  }
  return messages;
}

export class AgentRuntime {
  readonly events = mitt<AgentRuntimeEvents>();
  private client: IAgent<ModelClientOptions> | null = null;
  private runId = 0;
  private activeAbortController: AbortController | null = null;
  private activeRunUsageStartIndex: number | null = null;
  private activeRunCompleteUsageLength: number | null = null;
  private abortedRunUsageStartIndex: number | null = null;
  private abortedRunCompleteUsageLength: number | null = null;
  private currentConfig: AgentRuntimeConfig;
  private lastStatusKey: string | null = null;
  private activeRunStartedAt: number | null = null;
  private activeStatusModuleStartedAt: number | null = null;
  private activeStatusModuleKey = '';

  constructor() {
    this.currentConfig = readAgentRuntimeConfig();
    this.recreateClient();
  }

  get config() {
    return this.currentConfig;
  }

  get currentRunId() {
    return this.runId;
  }

  get isConfigured() {
    return Boolean(this.currentConfig.provider.api_key);
  }

  get isRunning() {
    return this.activeAbortController !== null;
  }

  get activeRunId() {
    return this.runId;
  }

  createSubAgent(options: Partial<ModelClientOptions> = {}) {
    if (!this.isConfigured) {
      const message = `${this.currentConfig.provider.name ?? this.currentConfig.provider.id} 未配置 api_key`;
      throw new Error(message);
    }
    return micaAgent.createSubAgent(this.createClientOptions(options));
  }

  createClientOptions(overrides: Partial<ModelClientOptions> = {}): ModelClientOptions {
    return mergeDefined(
      {
        ...createAgentClientOptions(this.currentConfig),
        toolContext: {
          agent: this,
          createClientOptions: this.createClientOptions.bind(this),
        },
      },
      overrides,
    );
  }

  reloadConfig(resetSession = true) {
    if (this.isRunning) {
      throw new Error('Cannot reload config while agent is running');
    }
    const previousSnapshot = !resetSession ? this.client?.getSnapshot() : null;
    if (resetSession) {
      this.runId++;
    }
    this.currentConfig = readAgentRuntimeConfig();
    this.recreateClient();
    if (!resetSession && previousSnapshot && this.client) {
      this.client.loadSnapshot({
        ...previousSnapshot,
        model: this.currentConfig.model,
      });
    }
    if (resetSession) {
      this.client?.reset();
      this.emitStatus({ type: 'idle' });
    }
  }

  abort() {
    this.runId++;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.emitStatus({ type: 'idle' });
  }

  clearSession() {
    this.runId++;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.client?.reset();
    this.emitStatus({ type: 'idle' });
  }

  getSnapshot(): AgentRuntimeSnapshot {
    const snapshot = this.client?.getSnapshot();
    return {
      providerId: this.currentConfig.provider.id,
      model: this.currentConfig.model,
      effort: this.currentConfig.provider.supportsEffort !== false ? this.currentConfig.effort : 'none',
      messages: snapshot?.messages ?? [],
      usageHistory: snapshot?.usageHistory ?? [],
      lastUsage: snapshot?.lastUsage,
    };
  }

  getForkSnapshot(options: { dropLastUserMessageAndAfter?: boolean } = {}): AgentRuntimeSnapshot {
    const snapshot = this.getSnapshot();
    const usageHistory =
      this.isRunning && this.activeRunUsageStartIndex !== null
        ? snapshot.usageHistory.slice(0, this.activeRunUsageStartIndex)
        : snapshot.usageHistory;
    return {
      ...snapshot,
      messages: options.dropLastUserMessageAndAfter
        ? dropLastUserMessageAndAfter(snapshot.messages)
        : snapshot.messages,
      usageHistory,
      lastUsage: usageHistory.at(-1),
    };
  }

  preserveAbortedTurn(question: AgentQueryContent, partialAnswer?: string) {
    if (!this.client) return false;
    this.trimAbortedRunUsage();
    const hadCurrentTurn = this.client.preserveAbortedTurn(question, partialAnswer);
    return hadCurrentTurn;
  }

  captureClientSnapshot() {
    const snapshot = this.client?.getSnapshot();
    if (!snapshot) return null;
    return {
      ...snapshot,
      messages: cloneJson(snapshot.messages),
      usageHistory: cloneJson(snapshot.usageHistory),
      lastUsage: cloneJson(snapshot.lastUsage),
      conversationMessages: cloneJson(snapshot.conversationMessages),
    };
  }

  restoreClientSnapshot(snapshot: AgentSnapshot<unknown, AgentUsageRecord>) {
    this.client?.loadSnapshot(snapshot);
  }

  loadSnapshot(snapshot: AgentRuntimeSnapshot) {
    if (this.isRunning) {
      throw new Error('Cannot load snapshot while agent is running');
    }
    this.runId++;
    this.currentConfig = agentRuntimeConfigFromSnapshot(snapshot);
    this.recreateClient();
    this.client?.loadSnapshot({
      model: snapshot.model,
      messages: snapshot.messages,
      usageHistory: snapshot.usageHistory,
      lastUsage: snapshot.lastUsage,
      conversationMessages: [],
    });
  }

  toConversationMessages(): MicaUiConversationMessage[] {
    return this.client?.toConversationMessages() ?? [];
  }

  async run(question: AgentQueryContent, options: AgentRunOptions = {}): Promise<{ runId: number; text: string }> {
    const runId = ++this.runId;
    const startedAt = Date.now();
    const questionText = contentToText(question);

    if (!this.client || !this.isConfigured) {
      const message = `${this.currentConfig.provider.name ?? this.currentConfig.provider.id} 未配置 api_key`;
      this.emitStatus({ type: 'error', message });
      throw new Error(message);
    }

    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.activeRunStartedAt = startedAt;
    this.activeRunUsageStartIndex = this.client.usageHistory.length;
    this.activeRunCompleteUsageLength = this.client.usageHistory.length;
    this.abortedRunUsageStartIndex = null;
    this.abortedRunCompleteUsageLength = null;
    this.emitStatus({ type: 'connecting', startedAt });
    try {
      const text = await this.client.query(question, {
        signal: abortController.signal,
        shouldContinue: () => this.isCurrent(runId),
        onIterationComplete: async () => {
          if (!this.isCurrent(runId)) return null;
          this.activeRunCompleteUsageLength = this.client?.usageHistory.length ?? this.activeRunCompleteUsageLength;
          return options.onIterationComplete?.() ?? null;
        },
      });
      if (this.isCurrent(runId)) {
        this.emitStatus({
          type: 'completed',
          startedAt,
          elapsedMs: Date.now() - startedAt,
        });
      }
      return { runId, text };
    } catch (error) {
      if (!this.isCurrent(runId) || isAbortError(error)) {
        this.abortedRunUsageStartIndex = this.activeRunUsageStartIndex;
        this.abortedRunCompleteUsageLength = this.activeRunCompleteUsageLength;
        throw new AgentAbortError(runId);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.isCurrent(runId)) this.emitStatus({ type: 'error', message });
      throw error;
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
      if (this.activeAbortController === null) {
        this.activeRunStartedAt = null;
        this.activeRunUsageStartIndex = null;
        this.activeRunCompleteUsageLength = null;
      }
    }
  }

  isCurrent(runId: number) {
    return runId === this.runId;
  }

  private recreateClient() {
    if (!this.currentConfig.provider.api_key) {
      this.client = null;
      return;
    }
    this.client = micaAgent.createModelClient(this.clientOptions());
    this.client.onText = (text) => {
      this.emitStatus({ type: 'streaming', startedAt: this.activeRunStartedAt ?? undefined });
      this.events.emit('text', text);
    };
    this.client.onThinking = (thinking) => {
      this.emitStatus({ type: 'thinking', startedAt: this.activeRunStartedAt ?? undefined });
      this.events.emit('thinking', thinking);
    };
    this.client.onToolCall = (name, args, id) => {
      this.emitStatus({ type: 'calling_tool', startedAt: this.activeRunStartedAt ?? undefined, toolNames: [name] });
      this.events.emit('toolCall', { name, args, id });
    };
    this.client.onToolResult = (name, result, id) => {
      this.events.emit('toolResult', { name, result, id });
      this.emitStatus({ type: 'connecting', startedAt: this.activeRunStartedAt ?? undefined });
    };
    this.client.onUsage = (usage) => {
      this.events.emit('usage', usage);
    };
  }

  private clientOptions(): ModelClientOptions {
    return this.createClientOptions();
  }

  private emitStatus(status: AgentRuntimeStatus): void {
    const nextStatus = this.withModuleStartedAt(status);
    const key = statusKey(nextStatus);
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.events.emit('status', nextStatus);
  }

  private withModuleStartedAt(status: AgentRuntimeStatus): AgentRuntimeStatus {
    const moduleKey = statusModuleKey(status);
    if (!moduleKey) {
      this.activeStatusModuleStartedAt = null;
      this.activeStatusModuleKey = '';
      return status;
    }

    if (this.activeStatusModuleKey !== moduleKey || !this.activeStatusModuleStartedAt) {
      this.activeStatusModuleKey = moduleKey;
      this.activeStatusModuleStartedAt = Date.now();
    }

    switch (status.type) {
      case 'connecting':
      case 'thinking':
      case 'streaming':
      case 'calling_tool':
        return { ...status, moduleStartedAt: this.activeStatusModuleStartedAt };
      default:
        return status;
    }
  }

  private trimAbortedRunUsage() {
    if (!this.client) return;
    const startIndex = this.abortedRunUsageStartIndex;
    const completeLength = this.abortedRunCompleteUsageLength;
    if (startIndex === null || completeLength === null) return;
    if (completeLength < this.client.usageHistory.length) {
      this.client.usageHistory = this.client.usageHistory.slice(0, completeLength) as typeof this.client.usageHistory;
      this.client.lastUsage = this.client.usageHistory.at(-1);
    }
    this.abortedRunUsageStartIndex = null;
    this.abortedRunCompleteUsageLength = null;
  }
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeDefined(base: ModelClientOptions, overrides: Partial<ModelClientOptions>): ModelClientOptions {
  const next = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  return next;
}

function statusKey(status: AgentRuntimeStatus): string {
  switch (status.type) {
    case 'calling_tool':
      return `${status.type}:${status.toolNames?.join(',') ?? ''}`;
    case 'completed':
      return `${status.type}:${status.elapsedMs ?? ''}`;
    case 'error':
      return `${status.type}:${status.message}`;
    default:
      return status.type;
  }
}

function statusModuleKey(status: AgentRuntimeStatus): string {
  switch (status.type) {
    case 'connecting':
    case 'thinking':
    case 'streaming':
      return status.type;
    case 'calling_tool':
      return `${status.type}:${status.toolNames?.join(',') ?? ''}`;
    default:
      return '';
  }
}
