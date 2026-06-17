import mitt from 'mitt';
import { createSubAgent, OpenAIClient, type OpenAIClientOptions } from '../../packages/agent/providers/OpenAIClient.js';
import type { AgentQueryContent, AgentSnapshot, IAgent, AgentUsageRecord } from '../../packages/agent/core/Agent.js';
import type { MicaUiConversationMessage } from '../../packages/mica-ui/types.js';
import type { EffortOption, ProviderDefinition } from '../config/index.js';
import { getConfig } from '../config/index.js';
import { logRuntime } from '../logger.js';

export type AgentRuntimeStatus =
  | { type: 'idle' }
  | { type: 'connecting' }
  | { type: 'thinking' }
  | { type: 'streaming' }
  | { type: 'calling_tool'; toolNames?: string[] }
  | { type: 'completed'; elapsedMs?: number }
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

type AgentRuntimeConfig = {
  provider: ProviderDefinition;
  model: string;
  effort: EffortOption;
};

export class AgentAbortError extends Error {
  constructor(readonly runId: number) {
    super('Agent run aborted');
    this.name = 'AgentAbortError';
  }
}

export class AgentRuntime {
  readonly events = mitt<AgentRuntimeEvents>();
  private client: IAgent<OpenAIClientOptions> | null = null;
  private runId = 0;
  private activeAbortController: AbortController | null = null;
  private currentConfig: AgentRuntimeConfig;

  constructor() {
    this.currentConfig = this.readConfig();
    this.recreateClient();
    logRuntime('agent', 'initialized', {
      provider: this.currentConfig.provider.id,
      model: this.currentConfig.model,
      configured: this.isConfigured,
    });
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

  createSubAgent(options: Partial<OpenAIClientOptions> = {}) {
    if (!this.isConfigured) {
      const message = `${this.currentConfig.provider.name ?? this.currentConfig.provider.id} 未配置 api_key`;
      throw new Error(message);
    }
    return createSubAgent({
      ...this.clientOptions(),
      ...options,
      effort: 'none',
    });
  }

  reloadConfig(resetSession = true) {
    this.currentConfig = this.readConfig();
    this.recreateClient();
    if (resetSession) this.clearSession();
    logRuntime('agent', 'config:reloaded', {
      provider: this.currentConfig.provider.id,
      model: this.currentConfig.model,
      resetSession,
      configured: this.isConfigured,
    });
  }

  abort() {
    this.runId++;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    logRuntime('agent', 'abort', { runId: this.runId }, 'warn');
    this.events.emit('status', { type: 'idle' });
  }

  clearSession() {
    this.runId++;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.client?.reset();
    logRuntime('agent', 'session:cleared', { runId: this.runId });
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

  loadSnapshot(snapshot: AgentRuntimeSnapshot) {
    this.runId++;
    this.client?.loadSnapshot({
      model: snapshot.model,
      messages: snapshot.messages,
      usageHistory: snapshot.usageHistory,
      lastUsage: snapshot.lastUsage,
      conversationMessages: [],
    });
    logRuntime('agent', 'snapshot:loaded', {
      provider: snapshot.providerId,
      model: snapshot.model,
      messages: snapshot.messages.length,
    });
  }

  toConversationMessages(): MicaUiConversationMessage[] {
    return this.client?.toConversationMessages() ?? [];
  }

  async run(question: AgentQueryContent): Promise<{ runId: number; text: string }> {
    const runId = ++this.runId;
    const startedAt = Date.now();
    const questionText = contentToText(question);
    logRuntime('agent', 'run:start', {
      runId,
      provider: this.currentConfig.provider.id,
      model: this.currentConfig.model,
      chars: questionText.length,
    });

    if (!this.client || !this.isConfigured) {
      const message = `${this.currentConfig.provider.name ?? this.currentConfig.provider.id} 未配置 api_key`;
      this.events.emit('status', { type: 'error', message });
      logRuntime('agent', 'run:not_configured', { runId, provider: this.currentConfig.provider.id }, 'error');
      throw new Error(message);
    }

    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.events.emit('status', { type: 'connecting' });
    try {
      const text = await this.client.query(question, {
        signal: abortController.signal,
        shouldContinue: () => this.isCurrent(runId),
      });
      if (this.isCurrent(runId)) {
        this.events.emit('status', {
          type: 'completed',
          elapsedMs: Date.now() - startedAt,
        });
        logRuntime('agent', 'run:completed', {
          runId,
          elapsedMs: Date.now() - startedAt,
          chars: text.length,
        });
      }
      return { runId, text };
    } catch (error) {
      if (!this.isCurrent(runId) || isAbortError(error)) {
        logRuntime('agent', 'run:aborted', { runId }, 'warn');
        throw new AgentAbortError(runId);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.isCurrent(runId)) this.events.emit('status', { type: 'error', message });
      logRuntime('agent', 'run:error', { runId, message }, 'error');
      throw error;
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
    }
  }

  isCurrent(runId: number) {
    return runId === this.runId;
  }

  private recreateClient() {
    if (!this.currentConfig.provider.api_key) {
      this.client = null;
      logRuntime('agent', 'client:disabled', { provider: this.currentConfig.provider.id }, 'warn');
      return;
    }
    this.client = new OpenAIClient(this.clientOptions());
    logRuntime('agent', 'client:created', {
      provider: this.currentConfig.provider.id,
      model: this.currentConfig.model,
      effort: this.currentConfig.provider.supportsEffort !== false ? this.currentConfig.effort : 'none',
    });
    this.client.onText = (text) => {
      this.events.emit('status', { type: 'streaming' });
      this.events.emit('text', text);
    };
    this.client.onThinking = (thinking) => {
      this.events.emit('status', { type: 'thinking' });
      this.events.emit('thinking', thinking);
    };
    this.client.onToolCall = (name, args, id) => {
      this.events.emit('status', { type: 'calling_tool', toolNames: [name] });
      this.events.emit('toolCall', { name, args, id });
      logRuntime('agent.tool', 'call', { name, id, argsChars: args.length });
    };
    this.client.onToolResult = (name, result, id) => {
      this.events.emit('toolResult', { name, result, id });
      logRuntime('agent.tool', 'result', { name, id, resultChars: result.length });
    };
    this.client.onUsage = (usage) => {
      this.events.emit('usage', usage);
      logRuntime('agent', 'usage', {
        input: usage.inputTokens,
        output: usage.outputTokens,
        total: usage.totalTokens,
        paidTokenRate: usage.paidTokenRate,
      });
    };
  }

  private clientOptions(): OpenAIClientOptions {
    return {
      apiKey: this.currentConfig.provider.api_key,
      baseURL: this.currentConfig.provider.api_base,
      model: this.currentConfig.model,
      effort: this.currentConfig.provider.supportsEffort !== false ? this.currentConfig.effort : 'none',
    };
  }

  private readConfig(): AgentRuntimeConfig {
    const config = getConfig();
    const provider = config.providers.find((item) => item.id === config.provider);
    if (!provider) {
      throw new Error(`Provider not found: ${config.provider || '(empty)'}`);
    }
    return {
      provider,
      model: config.model,
      effort: config.effort,
    };
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
