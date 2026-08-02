import mitt from 'mitt';
import {
  DEFAULT_ROLE_NAME,
  micaAgent,
  type AgentQueryContent,
  type AgentSnapshot,
  type IAgent,
  type AgentUsageRecord,
  type ModelClientOptions,
  type SubagentUsageRecord,
} from '@packages/mica-agent/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import type { EffortOption, ProviderProtocol } from '@packages/mica-config/index.js';
import { micaCommon } from '@packages/mica-common/index.js';
import type { HookRegistry } from '@packages/mica-plugin/index.js';
import {
  agentRuntimeConfigFromSnapshot,
  createAgentClientOptions,
  readAgentRuntimeConfig,
  type AgentRuntimeConfig,
  type AgentRuntimeConfigOverride,
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
  subagentUsage: SubagentUsageRecord;
  status: AgentRuntimeStatus;
};

export type AgentRuntimeSnapshot = {
  providerId: string;
  protocol: ProviderProtocol;
  model: string;
  effort: EffortOption;
  role: string;
  messages: AgentSnapshot<unknown, AgentUsageRecord>['messages'];
  usageHistory: AgentUsageRecord[];
  lastUsage: AgentUsageRecord | undefined;
  /** Usage of subagent tasks spawned by this agent, appended at task end. */
  subagentUsageHistory?: SubagentUsageRecord[];
};

type SystemPromptBuildEvent = {
  runtime: AgentRuntime;
  prompt: string;
};

type AgentRunOptions = {
  onIterationComplete?: () => AgentQueryContent | null | undefined | Promise<AgentQueryContent | null | undefined>;
  maxTurns?: number;
  reservedRunId?: number;
};

export class AgentAbortError extends Error {
  constructor(readonly runId = -1) {
    super('Agent run aborted');
    this.name = 'AgentAbortError';
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'AgentAbortError');
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
  readonly taskOwnerId = micaCommon.createId('agent-runtime');
  private client: IAgent<ModelClientOptions> | null = null;
  private runId = 0;
  private activeAbortController: AbortController | null = null;
  private activeRunUsageStartIndex: number | null = null;
  private activeRunCompleteUsageLength: number | null = null;
  private abortedRunUsageStartIndex: number | null = null;
  private abortedRunCompleteUsageLength: number | null = null;
  private currentConfig: AgentRuntimeConfig;
  private currentRole = DEFAULT_ROLE_NAME;
  private lastStatusKey: string | null = null;
  private activeRunStartedAt: number | null = null;
  private activeStatusModuleStartedAt: number | null = null;
  private activeStatusModuleKey = '';
  private subagentUsageHistory: SubagentUsageRecord[] = [];

  constructor(
    configOverride: AgentRuntimeConfigOverride = {},
    private readonly hooks?: HookRegistry,
  ) {
    this.currentConfig = readAgentRuntimeConfig(configOverride);
    this.recreateClient();
  }

  get config() {
    return this.currentConfig;
  }

  get role() {
    return this.resolveCurrentRole().name;
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
      const message = `${this.currentConfig.provider.name ?? this.currentConfig.provider.id} 未配置 api_key，运行 /config 命令配置后再尝试`;
      throw new Error(message);
    }
    return micaAgent.createSubAgent({
      ...this.createClientOptions(options),
      effort: options.effort ?? 'none',
    });
  }

  createClientOptions(overrides: Partial<ModelClientOptions> = {}): ModelClientOptions {
    return mergeDefined(
      {
        ...createAgentClientOptions(this.currentConfig),
        systemPrompt: () => this.buildSystemPrompt(),
        toolContext: {
          agent: this,
          createClientOptions: this.createClientOptions.bind(this),
        },
      },
      overrides,
    );
  }

  buildSystemPrompt(): string {
    const prompt = micaAgent.buildSystemPrompt({ baseSystemPrompt: this.resolveCurrentRole().prompt });
    const event = this.hooks?.pipelineSync<SystemPromptBuildEvent>('system-prompt:build', { runtime: this, prompt });
    return event?.prompt ?? prompt;
  }

  setRole(roleName: string): void {
    if (this.isRunning) {
      throw new Error('Cannot switch role while agent is running');
    }
    const role = micaAgent.roles.get(roleName);
    if (!role) throw new Error(`Role not found: ${roleName || '(empty)'}`);
    if (role.name === this.currentRole) return;

    const previousSnapshot = this.client?.getSnapshot();
    this.currentRole = role.name;
    this.recreateClient();
    if (previousSnapshot && this.client) {
      this.client.loadSnapshot(previousSnapshot);
    }
  }

  reloadConfig(resetSession = true) {
    if (this.isRunning) {
      throw new Error('Cannot reload config while agent is running');
    }
    const previousProtocol = this.currentConfig.provider.protocol;
    const previousSnapshot = !resetSession ? this.client?.getSnapshot() : null;
    if (resetSession) {
      this.runId++;
    }
    this.currentConfig = readAgentRuntimeConfig();
    this.recreateClient();
    if (!resetSession && previousProtocol === this.currentConfig.provider.protocol && previousSnapshot && this.client) {
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

  configureForRun(override: AgentRuntimeConfigOverride, preserveSession = true): void {
    if (this.isRunning) {
      throw new Error('Cannot configure agent while it is running');
    }
    const previousSnapshot = preserveSession ? this.client?.getSnapshot() : null;
    const previousProtocol = this.currentConfig.provider.protocol;
    const providerId = override.providerId ?? this.currentConfig.provider.id;
    const next = readAgentRuntimeConfig({
      providerId,
      model: override.model ?? (providerId === this.currentConfig.provider.id ? this.currentConfig.model : undefined),
      effort: override.effort ?? this.currentConfig.effort,
    });
    if (previousSnapshot && previousProtocol !== next.provider.protocol) {
      throw new Error(
        `Cannot resume a ${previousProtocol} session with ${next.provider.protocol}; start a fresh session instead.`,
      );
    }
    this.currentConfig = next;
    this.recreateClient();
    if (previousSnapshot && this.client) {
      this.client.loadSnapshot({ ...previousSnapshot, model: next.model });
    }
  }

  abort() {
    this.runId++;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.emitStatus({ type: 'idle' });
  }

  reserveRunId(): number {
    return ++this.runId;
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
      protocol: this.currentConfig.provider.protocol,
      model: this.currentConfig.model,
      effort: this.currentConfig.provider.supportsEffort !== false ? this.currentConfig.effort : 'none',
      role: this.role,
      messages: snapshot?.messages ?? [],
      usageHistory: snapshot?.usageHistory ?? [],
      lastUsage: snapshot?.lastUsage,
      subagentUsageHistory: this.subagentUsageHistory,
    };
  }

  getSubagentUsageHistory(): SubagentUsageRecord[] {
    return this.subagentUsageHistory;
  }

  /**
   * Appends one completed subagent task's usage. Called by the Agent tool when
   * a subagent finishes; records survive process restarts once persisted with
   * the session snapshot.
   */
  recordSubagentUsage(record: SubagentUsageRecord): void {
    this.subagentUsageHistory.push(record);
    this.events.emit('subagentUsage', record);
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
      subagentUsageHistory: this.subagentUsageHistory,
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
    this.currentRole = micaAgent.roles.get(snapshot.role)?.name ?? DEFAULT_ROLE_NAME;
    this.recreateClient();
    this.client?.loadSnapshot({
      model: snapshot.model,
      messages: snapshot.messages,
      usageHistory: snapshot.usageHistory,
      lastUsage: snapshot.lastUsage,
      conversationMessages: [],
    });
    this.subagentUsageHistory = snapshot.subagentUsageHistory ?? [];
  }

  toConversationMessages(): MicaUiConversationMessage[] {
    return this.client?.toConversationMessages() ?? [];
  }

  async run(question: AgentQueryContent, options: AgentRunOptions = {}): Promise<{ runId: number; text: string }> {
    const runId = options.reservedRunId ?? ++this.runId;
    const startedAt = Date.now();

    if (!this.isCurrent(runId)) throw new AgentAbortError(runId);

    if (!this.client || !this.isConfigured) {
      const message = `${this.currentConfig.provider.name ?? this.currentConfig.provider.id} 未配置 api_key，运行 /config 命令配置后再尝试`;
      this.emitStatus({ type: 'error', message });
      throw new Error(message);
    }
    if (!this.currentConfig.model) {
      const message = `未配置模型，运行 /model 命令选择模型后再尝试`;
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
        maxTurns: options.maxTurns,
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

  private resolveCurrentRole() {
    const role = micaAgent.roles.get(this.currentRole) ?? micaAgent.roles.get(DEFAULT_ROLE_NAME);
    if (!role) throw new Error('Built-in default role is unavailable');
    this.currentRole = role.name;
    return role;
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
