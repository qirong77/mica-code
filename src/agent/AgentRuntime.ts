import mitt from 'mitt';
import type { OpenAI } from 'openai';
import { micaAgent, type AgentQueryContent, type AgentSnapshot, type IAgent, type AgentUsageRecord, type OpenAIClientOptions } from '@packages/mica-agent/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import { micaConfig, type EffortOption, type ProviderDefinition } from '@packages/mica-config/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';

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

type AgentRunOptions = {
  onIterationComplete?: () => AgentQueryContent | null | undefined | Promise<AgentQueryContent | null | undefined>;
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
  private activeRunUsageStartIndex: number | null = null;
  private activeRunCompleteUsageLength: number | null = null;
  private abortedRunUsageStartIndex: number | null = null;
  private abortedRunCompleteUsageLength: number | null = null;
  private currentConfig: AgentRuntimeConfig;

  constructor() {
    this.currentConfig = this.readConfig();
    this.recreateClient();
    micaLogger.logRuntime('agent', 'initialized', {
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

  get isRunning() {
    return this.activeAbortController !== null;
  }

  createSubAgent(options: Partial<OpenAIClientOptions> = {}) {
    if (!this.isConfigured) {
      const message = `${this.currentConfig.provider.name ?? this.currentConfig.provider.id} 未配置 api_key`;
      throw new Error(message);
    }
    return micaAgent.createSubAgent({
      ...this.clientOptions(),
      ...options,
      effort: 'none',
    });
  }

  reloadConfig(resetSession = true) {
    if (this.isRunning) {
      throw new Error('Cannot reload config while agent is running');
    }
    const previousSnapshot = !resetSession ? this.client?.getSnapshot() : null;
    if (resetSession) {
      this.runId++;
    }
    this.currentConfig = this.readConfig();
    this.recreateClient();
    if (!resetSession && previousSnapshot && this.client) {
      this.client.loadSnapshot({
        ...previousSnapshot,
        model: this.currentConfig.model,
      });
    }
    if (resetSession) {
      this.client?.reset();
      this.events.emit('status', { type: 'idle' });
    }
    micaLogger.logRuntime('agent', 'config:reloaded', {
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
    micaLogger.logRuntime('agent', 'abort', { runId: this.runId }, 'warn');
    this.events.emit('status', { type: 'idle' });
  }

  clearSession() {
    this.runId++;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.client?.reset();
    micaLogger.logRuntime('agent', 'session:cleared', { runId: this.runId });
    this.events.emit('status', { type: 'idle' });
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
    const messages = [...(this.client.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[])];
    const hasCurrentTurn = messages.some((message) =>
      message.role === 'user' && isSameOpenAIUserContent(message.content, question),
    );
    if (hasCurrentTurn) {
      micaLogger.logRuntime('agent', 'turn:preserved_aborted_complete_iteration', { messages: messages.length }, 'warn');
      return true;
    }

    messages.push({ role: 'user', content: toOpenAIUserContent(question) });
    const answer = partialAnswer?.trim();
    if (answer) {
      messages.push({ role: 'assistant', content: answer });
    }
    this.client.messages = messages as typeof this.client.messages;
    micaLogger.logRuntime('agent', 'turn:preserved_aborted', { messages: messages.length, hasPartialAnswer: Boolean(answer) }, 'warn');
    return false;
  }

  loadSnapshot(snapshot: AgentRuntimeSnapshot) {
    if (this.isRunning) {
      throw new Error('Cannot load snapshot while agent is running');
    }
    this.runId++;
    this.currentConfig = this.configFromSnapshot(snapshot);
    this.recreateClient();
    this.client?.loadSnapshot({
      model: snapshot.model,
      messages: snapshot.messages,
      usageHistory: snapshot.usageHistory,
      lastUsage: snapshot.lastUsage,
      conversationMessages: [],
    });
    micaLogger.logRuntime('agent', 'snapshot:loaded', {
      provider: snapshot.providerId,
      model: snapshot.model,
      messages: snapshot.messages.length,
    });
  }

  toConversationMessages(): MicaUiConversationMessage[] {
    return this.client?.toConversationMessages() ?? [];
  }

  async run(question: AgentQueryContent, options: AgentRunOptions = {}): Promise<{ runId: number; text: string }> {
    const runId = ++this.runId;
    const startedAt = Date.now();
    const questionText = contentToText(question);
    micaLogger.logRuntime('agent', 'run:start', {
      runId,
      provider: this.currentConfig.provider.id,
      model: this.currentConfig.model,
      chars: questionText.length,
    });

    if (!this.client || !this.isConfigured) {
      const message = `${this.currentConfig.provider.name ?? this.currentConfig.provider.id} 未配置 api_key`;
      this.events.emit('status', { type: 'error', message });
      micaLogger.logRuntime('agent', 'run:not_configured', { runId, provider: this.currentConfig.provider.id }, 'error');
      throw new Error(message);
    }

    const abortController = new AbortController();
    this.activeAbortController = abortController;
    this.activeRunUsageStartIndex = this.client.usageHistory.length;
    this.activeRunCompleteUsageLength = this.client.usageHistory.length;
    this.abortedRunUsageStartIndex = null;
    this.abortedRunCompleteUsageLength = null;
    this.events.emit('status', { type: 'connecting' });
    try {
      const text = await this.client.query(question, {
        signal: abortController.signal,
        shouldContinue: () => this.isCurrent(runId),
        onIterationComplete: async () => {
          if (!this.isCurrent(runId)) return null;
          this.activeRunCompleteUsageLength = this.client?.usageHistory.length ?? this.activeRunCompleteUsageLength;
          micaLogger.logRuntime('agent', 'run:iteration_complete', { runId });
          return options.onIterationComplete?.() ?? null;
        },
      });
      if (this.isCurrent(runId)) {
        this.events.emit('status', {
          type: 'completed',
          elapsedMs: Date.now() - startedAt,
        });
        micaLogger.logRuntime('agent', 'run:completed', {
          runId,
          elapsedMs: Date.now() - startedAt,
          chars: text.length,
        });
      }
      return { runId, text };
    } catch (error) {
      if (!this.isCurrent(runId) || isAbortError(error)) {
        this.abortedRunUsageStartIndex = this.activeRunUsageStartIndex;
        this.abortedRunCompleteUsageLength = this.activeRunCompleteUsageLength;
        micaLogger.logRuntime('agent', 'run:aborted', { runId }, 'warn');
        throw new AgentAbortError(runId);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (this.isCurrent(runId)) this.events.emit('status', { type: 'error', message });
      micaLogger.logRuntime('agent', 'run:error', { runId, message }, 'error');
      throw error;
    } finally {
      if (this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
      if (this.activeAbortController === null) {
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
      micaLogger.logRuntime('agent', 'client:disabled', { provider: this.currentConfig.provider.id }, 'warn');
      return;
    }
    this.client = new micaAgent.OpenAIClient(this.clientOptions());
    micaLogger.logRuntime('agent', 'client:created', {
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
      micaLogger.logRuntime('agent.tool', 'call', { name, id, argsChars: args.length });
    };
    this.client.onToolResult = (name, result, id) => {
      this.events.emit('toolResult', { name, result, id });
      micaLogger.logRuntime('agent.tool', 'result', { name, id, resultChars: result.length });
    };
    this.client.onUsage = (usage) => {
      this.events.emit('usage', usage);
      micaLogger.logRuntime('agent', 'usage', {
        input: usage.inputTokens,
        cachedInput: usage.cachedInputTokens ?? 0,
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
    const config = micaConfig.get();
    const provider = config.providers.find((item) => item.id === config.provider);
    if (!provider) {
      throw new Error(formatProviderNotFoundMessage(config));
    }
    return {
      provider,
      model: config.model,
      effort: config.effort,
    };
  }

  private configFromSnapshot(snapshot: AgentRuntimeSnapshot): AgentRuntimeConfig {
    const config = micaConfig.get();
    const provider = config.providers.find((item) => item.id === snapshot.providerId);
    if (!provider) {
      throw new Error(`Provider not found: ${snapshot.providerId || '(empty)'}`);
    }
    return {
      provider,
      model: snapshot.model || provider.model,
      effort: provider.supportsEffort === false ? 'none' : snapshot.effort,
    };
  }

  private trimAbortedRunUsage() {
    if (!this.client) return;
    const startIndex = this.abortedRunUsageStartIndex;
    const completeLength = this.abortedRunCompleteUsageLength;
    if (startIndex === null || completeLength === null) return;
    if (completeLength < this.client.usageHistory.length) {
      this.client.usageHistory = this.client.usageHistory.slice(0, completeLength) as typeof this.client.usageHistory;
      this.client.lastUsage = this.client.usageHistory.at(-1);
      micaLogger.logRuntime(
        'agent',
        'run:trim_aborted_usage',
        { startIndex, completeLength, usage: this.client.usageHistory.length },
        'warn',
      );
    }
    this.abortedRunUsageStartIndex = null;
    this.abortedRunCompleteUsageLength = null;
  }
}

function formatProviderNotFoundMessage(config: ReturnType<typeof micaConfig.get>): string {
  const configuredProvider = config.provider || '(empty)';
  const availableProviders = config.providers.map((provider) => provider.id);
  const matchingProviders = config.providers
    .filter((provider) => provider.model === config.model || provider.models?.includes(config.model))
    .map((provider) => provider.id);

  const lines = [
    `Provider not found: ${configuredProvider}`,
    `配置文件 ${micaConfig.path} 中的 "provider" 必须匹配 providers[].id。`,
  ];

  if (availableProviders.length > 0) {
    lines.push(`可用 provider: ${availableProviders.join(', ')}`);
  } else {
    lines.push('当前没有可用 provider，请先在配置文件中添加 providers。');
  }

  if (config.model && matchingProviders.length > 0) {
    lines.push(`当前 model "${config.model}" 可匹配 provider: ${matchingProviders.join(', ')}`);
  }

  lines.push('修复配置后重新运行 mica。');
  return lines.join('\n');
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

function toOpenAIUserContent(content: AgentQueryContent): OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content'] {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    return {
      type: 'image_url',
      image_url: {
        url: `data:${part.source.media_type};base64,${part.source.data}`,
      },
    };
  });
}

function isSameOpenAIUserContent(
  left: OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content'],
  right: AgentQueryContent,
): boolean {
  return JSON.stringify(left) === JSON.stringify(toOpenAIUserContent(right));
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
