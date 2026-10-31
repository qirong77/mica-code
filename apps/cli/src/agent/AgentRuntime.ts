import mitt from 'mitt';
import { AsyncLocalStorage } from 'node:async_hooks';
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
import { micaConfig } from '@packages/mica-config/index.js';
import { micaCommon, cloneCapabilitySelection, normalizeCapabilitySelection } from '@packages/mica-common/index.js';
import type { CapabilitySelection } from '@packages/mica-common/index.js';
import { micaSkills, type Skill } from '@packages/mica-skills/index.js';
import { mcpToolNamePrefix, micaTools } from '@packages/mica-tools/index.js';
import { estimateContextTokens, estimateTextTokens } from '@packages/mica-context/tokenEstimate.js';
import type { AgentObservationEvent, HookRegistry } from '@packages/mica-plugin/index.js';
import { applyIterationRewrites } from './iterationRewrite.js';
import {
  PluginPromptSections,
  normalizePluginSessionSettingsRecord,
  normalizePluginStateRecord,
  validatePluginStateValue,
  type PluginSessionSettingsRecord,
  type PluginSettingValues,
  type PluginStateRecord,
} from '@packages/mica-plugin/index.js';
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
  capabilitySelection?: CapabilitySelection;
  /**
   * 用户在会话里显式改过能力开关吗？false / 缺失表示这份会话跟随 config 的
   * `capabilityDefaults`，只有改过的会话才固定用自己的选择。
   */
  capabilitiesCustomized?: boolean;
  /**
   * 插件在本会话里的持久状态：插件 id → 插件自己的 JSON。
   *
   * 内核不理解内容，只保证它跨 compact 存活、随 resume / fork 带回、新会话清空。
   * 会话笔记是最早的用法，但它只是众多消费者之一。
   */
  pluginState?: PluginStateRecord;
  /** 插件设置的会话覆盖：插件 id → 只记改过的键。 */
  pluginSessionSettings?: PluginSessionSettingsRecord;
  /** Derived model context window in tokens, used by headless/session tooling. */
  contextWindowSize?: number;
  /**
   * 最近一次请求实际发出的 system prompt 全文（角色 + 项目说明 + skills + 插件段落）。
   *
   * 只随会话快照落盘供界面查看，不会用来重建请求：下一轮仍然重新拼装。
   */
  systemPrompt?: string;
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
  /** provider 层重试（零输出安全重发）每次触发前回调，供调用方展示重试状态。 */
  onRetry?: (info: { attempt: number; error: unknown; delayMs: number }) => void;
  maxTurns?: number;
  reservedRunId?: number;
};

type ObservationPayload = AgentObservationEvent extends infer Event
  ? Event extends AgentObservationEvent
    ? Omit<Event, 'owner' | 'runId' | 'timestamp'>
    : never
  : never;

type ObservedRun = { runId: number; closed: boolean };

export class AgentAbortError extends Error {
  constructor(readonly runId = -1) {
    super('Agent run aborted');
    this.name = 'AgentAbortError';
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'AgentAbortError');
}

/**
 * 默认能力来自 config.json，每次构建请求都会读到：短 TTL 摊掉读盘成本，但不会
 * 把值长期钉在内存里，配置页改完默认值后面板很快就能看到新值。
 */
const DEFAULT_CAPABILITIES_TTL_MS = 1000;

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
  // Async scope prevents UI prompt previews and callbacks left by an older run
  // from being attributed to whichever run happens to be active now.
  private readonly observationScope = new AsyncLocalStorage<ObservedRun>();
  private activeAbortController: AbortController | null = null;
  private activeRunUsageStartIndex: number | null = null;
  private activeRunCompleteUsageLength: number | null = null;
  private abortedRunUsageStartIndex: number | null = null;
  private abortedRunCompleteUsageLength: number | null = null;
  private currentConfig: AgentRuntimeConfig;
  private currentRole = DEFAULT_ROLE_NAME;
  private capabilities: CapabilitySelection = normalizeCapabilitySelection(micaConfig.readCapabilityDefaults());
  /** 用户是否在会话里显式改过能力；false 时这份会话跟随 config 的默认值。 */
  private capabilitiesCustomized = false;
  private defaultCapabilitiesCache: { at: number; value: CapabilitySelection } | null = null;
  /**
   * 插件在本会话里的持久状态（键是插件 id）。内核只负责存取与清洗，不理解内容。
   *
   * 放在会话快照而不是插件自己写盘：这样它天然跟着 resume / fork / compact 语义走，
   * 也不会出现「插件重启后状态还在、会话已经换了」的错配。
   */
  private pluginState: PluginStateRecord = {};
  private pluginSessionSettings: PluginSessionSettingsRecord = {};
  /** 插件向 system prompt 贡献的段落，每轮重新渲染。 */
  readonly promptSections = new PluginPromptSections();
  /**
   * 最近一次真正发给模型的主请求 system prompt。
   *
   * 只在主 client 的 resolver 里记录（子代理 / BTW 有自己的提示词，不覆盖会话视图），
   * 随快照落盘后界面就能回答「这次请求到底带了什么」。
   */
  private lastSystemPrompt: string | undefined;
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

  get capabilitySelection(): CapabilitySelection {
    return cloneCapabilitySelection(this.resolvedCapabilities());
  }

  /**
   * 本会话的能力开关。只改当前 agent：工具定义、执行校验与 skills 索引都读这份
   * 状态，其他会话与全局注册表不受影响。运行中拒绝切换，避免一轮里的工具集抖动。
   *
   * 默认把这份选择标记为「用户定制」：之后它不再跟随 config 的默认值。传
   * `customized: false` 只用于把值灌进会话内部状态、不改变跟随关系。
   */
  setCapabilities(selection: CapabilitySelection, options: { customized?: boolean } = {}): CapabilitySelection {
    if (this.isRunning) {
      throw new Error('Cannot change capabilities while agent is running');
    }
    this.capabilities = normalizeCapabilitySelection(selection);
    this.capabilitiesCustomized = options.customized ?? true;
    return this.capabilitySelection;
  }

  /**
   * 新会话（`/new`、`/clear`）回到「跟随 config 默认值」：清掉定制标志，
   * 所以上一条会话关掉的工具不会漏到这一条。
   */
  resetCapabilitiesToDefaults(): CapabilitySelection {
    if (this.isRunning) {
      throw new Error('Cannot change capabilities while agent is running');
    }
    this.capabilities = cloneCapabilitySelection(this.resolveDefaultCapabilities());
    this.capabilitiesCustomized = false;
    return this.capabilitySelection;
  }

  /** 读某个插件在本会话里的状态。没写过返回 undefined。 */
  getPluginState<T = unknown>(pluginId: string): T | undefined {
    return this.pluginState[pluginId] as T | undefined;
  }

  /**
   * 覆盖某个插件在本会话里的状态。
   *
   * 运行中允许调用：插件状态不进对话历史，改它既不会打断在途请求，也不会让本轮
   * 中途换上下文——下一次请求自然会带上新内容。超出配额直接抛错，让插件自己知道
   * 写不进去，而不是悄悄被截断。
   */
  setPluginState(pluginId: string, value: unknown): void {
    if (!pluginId.trim()) throw new Error('plugin id must not be empty');
    const problem = validatePluginStateValue(value);
    if (problem) throw new Error(`${pluginId}: ${problem}`);
    if (value === undefined) {
      delete this.pluginState[pluginId];
      return;
    }
    this.pluginState[pluginId] = value;
  }

  /** 丢掉某个插件的状态（插件自行清空时用）。 */
  clearPluginState(pluginId: string): void {
    delete this.pluginState[pluginId];
  }

  /** 本会话对某个插件设置的覆盖（只含改过的键）。 */
  getPluginSessionSettings(pluginId: string): PluginSettingValues | undefined {
    const value = this.pluginSessionSettings[pluginId];
    return value ? { ...value } : undefined;
  }

  /** 覆盖某个插件在本会话里的设置；传 undefined 表示清空覆盖、全部跟随默认值。 */
  setPluginSessionSettings(pluginId: string, value: PluginSettingValues | undefined): void {
    if (!pluginId.trim()) throw new Error('plugin id must not be empty');
    if (value === undefined) {
      delete this.pluginSessionSettings[pluginId];
      return;
    }
    this.pluginSessionSettings[pluginId] = { ...value };
  }

  /** 当前会话可用的 skills（已应用本会话开关）。 */
  availableSkills(): Skill[] {
    const disabled = new Set(this.resolvedCapabilities().disabledSkills);
    return micaSkills.getLoaded().filter((skill) => !disabled.has(skill.name));
  }

  private isToolEnabledByCapabilities = (name: string): boolean => {
    const capabilities = this.resolvedCapabilities();
    if (capabilities.disabledTools.includes(name)) return false;
    for (const server of capabilities.disabledMcpServers) {
      if (name.startsWith(mcpToolNamePrefix(server))) return false;
    }
    return true;
  };

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
      const message = `${this.currentConfig.provider.id} 未配置 api_key，运行 /config 命令配置后再尝试`;
      throw new Error(message);
    }
    return micaAgent.createSubAgent({
      ...this.createClientOptions(options),
      effort: options.effort ?? 'none',
    });
  }

  createClientOptions(overrides: Partial<ModelClientOptions> = {}): ModelClientOptions {
    const merged = mergeDefined(
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
    // 会话能力与调用方自己的过滤（子代理类型、BTW 模式）取交集：任何一方说不
    // 可用，工具就不会出现在本轮请求里，也不会被执行。
    const callerFilter = overrides.toolFilter;
    merged.toolFilter = (name) => this.isToolEnabledByCapabilities(name) && (!callerFilter || callerFilter(name));
    return merged;
  }

  buildSystemPrompt(): string {
    const prompt = micaAgent.buildSystemPrompt({
      baseSystemPrompt: this.resolveCurrentRole().prompt,
      skills: this.availableSkills(),
    });
    const event = this.hooks?.pipelineSync<SystemPromptBuildEvent>('system-prompt:build', { runtime: this, prompt });
    const base = event?.prompt ?? prompt;
    // 插件段落固定追加在最末：它们才是「每轮可能变」的内容（会话笔记、循环说明），
    // 放在最后才不会让前面稳定的 system / AGENT.md / skills / context 跟着一起失效。
    const pluginSections = this.promptSections.render();
    return pluginSections ? `${base}\n\n${pluginSections}` : base;
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
    // /clear 与新建会话都是「这条会话从这里重来」：插件状态属于会话，跟着一起清掉，
    // 否则新会话会莫名其妙继承上一轮的结论。
    this.pluginState = {};
    this.pluginSessionSettings = {};
    // 记下来的提示词也属于这条会话：新会话的第一轮请求会重新记录。
    this.lastSystemPrompt = undefined;
    this.emitStatus({ type: 'idle' });
  }

  getLastUsage(): AgentUsageRecord | undefined {
    return this.client?.lastUsage;
  }

  /** The prompt and tool schemas share the provider's context budget. */
  estimateRequestOverheadTokens(): number {
    return estimateTextTokens(this.systemPrompt ?? '') + estimateContextTokens(micaTools.getDefinitions(this.isToolEnabledByCapabilities));
  }

  get systemPrompt(): string | undefined {
    return this.lastSystemPrompt;
  }

  getSnapshot(): AgentRuntimeSnapshot {
    const snapshot = this.client?.getSnapshot();
    return {
      providerId: this.currentConfig.provider.id,
      protocol: this.currentConfig.provider.protocol,
      model: this.currentConfig.model,
      effort: this.currentConfig.provider.supportsEffort !== false ? this.currentConfig.effort : 'none',
      role: this.role,
      capabilitySelection: this.capabilitySelection,
      capabilitiesCustomized: this.capabilitiesCustomized,
      pluginState: this.pluginState,
      pluginSessionSettings: this.pluginSessionSettings,
      contextWindowSize: this.currentConfig.provider.contextWindowSize,
      systemPrompt: this.lastSystemPrompt,
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
    // fork 继承的是对话与上下文，不是用量记账：新会话的 Stats 从空开始（它自己这一轮
    // 还没发生任何请求），同一条请求也就不会在两个会话里被各算一次。
    // `lastUsage` 例外——它描述的是继承来的上下文占用，界面上的 ctx 需要它。
    return {
      ...snapshot,
      messages: options.dropLastUserMessageAndAfter
        ? dropLastUserMessageAndAfter(snapshot.messages)
        : snapshot.messages,
      usageHistory: [],
      lastUsage: snapshot.lastUsage,
      subagentUsageHistory: [],
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
    // 旧快照没有 `capabilitiesCustomized`：以前的实现把当时的默认值复制进了快照，
    // 这份副本几乎总是等于默认值，按「未定制」处理（跟随当前 config 默认值）比把
    // 它当成用户的显式选择更符合意图；用户在面板里再点一下就会重新变成定制，
    // 没有丢任何真实偏好。
    this.capabilitiesCustomized = snapshot.capabilitiesCustomized === true;
    this.capabilities = normalizeCapabilitySelection(snapshot.capabilitySelection ?? this.resolveDefaultCapabilities());
    this.pluginState = normalizePluginStateRecord(snapshot.pluginState);
    this.pluginSessionSettings = normalizePluginSessionSettingsRecord(snapshot.pluginSessionSettings);
    // 恢复上一次请求的提示词：还没发新请求时，界面看到的是这条会话真正用过的那一份。
    this.lastSystemPrompt = typeof snapshot.systemPrompt === 'string' ? snapshot.systemPrompt : undefined;
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
    const observed: ObservedRun = { runId, closed: false };
    let outcome: 'completed' | 'aborted' | 'error' = 'completed';
    let observationError: string | undefined;
    let abortController: AbortController | undefined;
    this.observe(observed, {
      type: 'run:start',
      input: cloneJson(question),
      config: Object.freeze({
        providerId: this.currentConfig.provider.id,
        protocol: this.currentConfig.provider.protocol,
        model: this.currentConfig.model,
        effort: this.currentConfig.provider.supportsEffort !== false ? this.currentConfig.effort : 'none',
        role: this.currentRole,
      }),
    });
    try {
      if (!this.isCurrent(runId)) throw new AgentAbortError(runId);
      if (!this.client || !this.isConfigured) {
        const message = `${this.currentConfig.provider.id} 未配置 api_key，运行 /config 命令配置后再尝试`;
        throw new Error(message);
      }
      if (!this.currentConfig.model) {
        const message = '未配置模型，运行 /model 命令选择模型后再尝试';
        throw new Error(message);
      }
      abortController = new AbortController();
      this.activeAbortController = abortController;
      this.activeRunStartedAt = startedAt;
      this.activeRunUsageStartIndex = this.client.usageHistory.length;
      this.activeRunCompleteUsageLength = this.client.usageHistory.length;
      this.abortedRunUsageStartIndex = null;
      this.abortedRunCompleteUsageLength = null;
      this.emitStatus({ type: 'connecting', startedAt });
      const client = this.client;
      const signal = abortController.signal;
      const text = await this.observationScope.run(observed, () =>
        client.query(question, {
          signal,
          shouldContinue: () => this.isCurrent(runId),
          maxTurns: options.maxTurns,
          onRequestStart: (info) => {
            if (!this.isCurrent(runId)) return;
            this.observeActive({
              type: 'request:start',
              messageCount: info.messageCount,
              ...(info.tools === undefined ? {} : { tools: cloneJson(info.tools) }),
            });
          },
          onRetry: (info) => {
            if (!this.isCurrent(runId)) return;
            this.observeActive({
              type: 'retry',
              attempt: info.attempt,
              delayMs: info.delayMs,
              error: info.error instanceof Error ? info.error.message : String(info.error),
            });
            options.onRetry?.(info);
          },
          rewriteIterationMessages: async (messages) => {
            if (!this.isCurrent(runId)) return null;
            const beforeCount = messages.length;
            const rewritten = await applyIterationRewrites(messages, this, signal);
            if (rewritten && this.isCurrent(runId)) {
              this.observeActive({ type: 'history:rewritten', beforeCount, afterCount: rewritten.length });
            }
            return rewritten;
          },
          onIterationComplete: async () => {
            if (!this.isCurrent(runId)) return null;
            this.activeRunCompleteUsageLength = this.client?.usageHistory.length ?? this.activeRunCompleteUsageLength;
            return options.onIterationComplete?.() ?? null;
          },
        }),
      );
      if (!this.isCurrent(runId) || signal.aborted) outcome = 'aborted';
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
        outcome = 'aborted';
        if (abortController) {
          this.abortedRunUsageStartIndex = this.activeRunUsageStartIndex;
          this.abortedRunCompleteUsageLength = this.activeRunCompleteUsageLength;
        }
        throw new AgentAbortError(runId);
      }
      const message = error instanceof Error ? error.message : String(error);
      outcome = 'error';
      observationError = message;
      if (this.isCurrent(runId)) this.emitStatus({ type: 'error', message });
      throw error;
    } finally {
      if (abortController && this.activeAbortController === abortController) {
        this.activeAbortController = null;
      }
      if (abortController && this.activeAbortController === null) {
        this.activeRunStartedAt = null;
        this.activeRunUsageStartIndex = null;
        this.activeRunCompleteUsageLength = null;
      }
      observed.closed = true;
      this.observe(observed, {
        type: 'run:finish',
        outcome,
        elapsedMs: Date.now() - startedAt,
        ...(observationError === undefined ? {} : { error: observationError }),
      });
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
      this.observeActive({ type: 'tool:call', name, args, id });
      this.emitStatus({ type: 'calling_tool', startedAt: this.activeRunStartedAt ?? undefined, toolNames: [name] });
      this.events.emit('toolCall', { name, args, id });
    };
    this.client.onToolResult = (name, result, id) => {
      this.observeActive({ type: 'tool:result', name, result, id });
      this.events.emit('toolResult', { name, result, id });
      this.emitStatus({ type: 'connecting', startedAt: this.activeRunStartedAt ?? undefined });
    };
    this.client.onUsage = (usage) => {
      this.observeActive({
        type: 'usage',
        usage: Object.freeze({
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          totalTokens: usage.totalTokens,
          model: usage.model,
        }),
      });
      this.events.emit('usage', usage);
    };
  }

  private clientOptions(): ModelClientOptions {
    return this.createClientOptions({
      systemPrompt: () => {
        const prompt = this.buildSystemPrompt();
        // 会话快照保留这一份：界面上的「系统提示词」看的就是真正发出去的内容，而不是
        // 角色文件里那一段（skills 索引、AGENT.md 与插件段落都只在这里可见）。
        this.lastSystemPrompt = prompt;
        // Only the main client's resolver observes the returned prompt. Shared
        // createClientOptions() callbacks used by subrequests do not report it.
        this.observeActive({ type: 'prompt:resolved', prompt });
        return prompt;
      },
    });
  }

  private observeActive(payload: ObservationPayload): void {
    const observed = this.observationScope.getStore();
    if (!observed || observed.closed || !this.isCurrent(observed.runId)) return;
    this.observe(observed, payload);
  }

  private observe(observed: ObservedRun, payload: ObservationPayload): void {
    if (!this.hooks) return;
    const event: AgentObservationEvent = Object.freeze({
      ...payload,
      owner: this,
      runId: observed.runId,
      timestamp: new Date().toISOString(),
    });
    // Diagnostic callbacks never delay completion/abort, including a handler that
    // returns a promise which never settles. Plugins own their IO flush lifecycle.
    this.observationScope.exit(() => this.hooks!.notify('agent:observe', event));
  }

  private resolveCurrentRole() {
    const role = micaAgent.roles.get(this.currentRole) ?? micaAgent.roles.get(DEFAULT_ROLE_NAME);
    if (!role) throw new Error('Built-in default role is unavailable');
    this.currentRole = role.name;
    return role;
  }

  /** 当前 config.json 里的新会话默认能力（读盘结果带短 TTL 缓存）。 */
  private resolveDefaultCapabilities(): CapabilitySelection {
    const now = Date.now();
    const cached = this.defaultCapabilitiesCache;
    if (cached && now - cached.at < DEFAULT_CAPABILITIES_TTL_MS) return cached.value;
    const value = normalizeCapabilitySelection(micaConfig.readCapabilityDefaults());
    this.defaultCapabilitiesCache = { at: now, value };
    return value;
  }

  /** 会话实际生效的能力：改过的用自己的，没改过的跟着默认值走。 */
  private resolvedCapabilities(): CapabilitySelection {
    return this.capabilitiesCustomized ? this.capabilities : this.resolveDefaultCapabilities();
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
