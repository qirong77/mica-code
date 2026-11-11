import mitt from 'mitt';
import type { Message } from '@earendil-works/pi-ai';
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
import { PI_MESSAGE_FORMAT, PI_MESSAGE_FORMAT_ERROR } from '@packages/mica-common/messageFormat.js';
import { micaCommon, cloneCapabilitySelection, normalizeCapabilitySelection } from '@packages/mica-common/index.js';
import type { CapabilitySelection } from '@packages/mica-common/index.js';
import {
  applyTurnTimingTick,
  appendTurnTiming,
  createTurnTimingState,
  normalizeTurnTimings,
  turnTimingRecord,
  type TurnTimingRecord,
  type TurnTimingState,
  type TurnTimingTick,
  type TurnTimingOutcome,
} from '@packages/mica-common/turnTiming.js';
import { micaSkills, type Skill } from '@packages/mica-skills/index.js';
import { mcpToolNamePrefix, micaTools } from '@packages/mica-tools/index.js';
import { estimateTextTokens } from '@packages/mica-context/tokenEstimate.js';
import type {
  AgentObservationEvent,
  HookRegistry,
  PluginCompactOptions,
  PluginCompactResult,
} from '@packages/mica-plugin/index.js';
import { compactAgentMessages, isNothingToCompact } from './agentCompaction.js';
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
  textAttemptStart: undefined;
  textRollback: undefined;
  thinking: string;
  thinkingCheckpoint: undefined;
  thinkingRollback: undefined;
  thinkingReset: undefined;
  /** Display state at the start of, and after discarding, a whole turn attempt. */
  thinkingTurnAttemptStart?: undefined;
  thinkingTurnAttemptRollback?: undefined;
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
  messageFormat?: 'pi-ai-v1';
  messages: Message[];
  usageHistory: AgentUsageRecord[];
  lastUsage: AgentUsageRecord | undefined;
  /** Display-only checkpoint. It is never included in a model request. */
  interruptedThinking?: InterruptedThinking;
  /** Completed thinking while the current turn is still running. */
  activeThinking?: InterruptedThinking;
  /** Input associated with the running history, for crash recovery. */
  activeTurn?: { input: AgentQueryContent; committed: boolean };
  /** Usage of subagent tasks spawned by this agent, appended at task end. */
  subagentUsageHistory?: SubagentUsageRecord[];
  /**
   * 最近若干轮的时间去向（新的在后）。
   *
   * 记在会话里的理由：界面要能回看「上一轮慢在哪」，而桌面端打开会话详情时
   * 手里只有磁盘上的会话——只留在页面内存里，重开应用就什么都没了。
   */
  turnTimings?: TurnTimingRecord[];
};

export type InterruptedThinking = {
  providerId: string;
  protocol: ProviderProtocol;
  model: string;
  apiBase: string;
  text: string;
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

type RunStartObservation = Extract<AgentObservationEvent, { type: 'run:start' }>;

/**
 * `run:start.delegation` 的形状：委派子代理的类型名与被派生的会话。
 *
 * 从观察契约里取，而不是在这里再写一份——加字段时只需要改那一处。
 */
export type AgentDelegationObservation = NonNullable<RunStartObservation['delegation']>;

/**
 * `run:start.helper` 的形状：不属于任何一轮的宿主内部工作（压缩摘要、旁问线程、
 * 插件自己问模型）。`kind` 是稳定的来源短名，观察方据此归并成本。
 */
export type AgentHelperObservation = { kind: string; pluginId?: string; purpose?: string };

/** `createSubAgent` 的观察分类：要么是委派（有类型），要么是 helper（有来源）。 */
export type AgentSubagentObservation = {
  delegation?: AgentDelegationObservation;
  helper?: AgentHelperObservation;
};

/** 交给子运行包装层的分类标记，二选一。 */
type RunMarker = { delegation?: AgentDelegationObservation; helper?: AgentHelperObservation };

/**
 * 一次 helper 运行的句柄（`startHelperRun`）。
 *
 * `callbacks` 原样交给模型客户端；`finish` 必须在 `finally` 里调一次，成功与失败都要，
 * 否则这次运行会一直停在 `running`。
 */
export type HelperRunHandle = {
  callbacks: {
    onRequestStart: (info: { messageCount: number; tools?: unknown }) => void;
    onRequestEnd: (info: {
      durationMs: number;
      firstTokenMs?: number;
      attempts: number;
      outcome: 'completed' | 'error' | 'aborted';
      toolCalls?: number;
      error?: string;
    }) => void;
    onRetry: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  };
  finish(outcome: 'completed' | 'error' | 'aborted', error?: unknown, usage?: readonly AgentUsageRecord[]): void;
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

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 固定的观察形状：kind 不能是空白（观察方按它归并），其余两项缺省就不写。 */
function freezeHelper(info: AgentHelperObservation): NonNullable<RunStartObservation['helper']> {
  const kind = info.kind.trim() || 'helper';
  return Object.freeze({
    kind,
    ...(info.pluginId ? { pluginId: info.pluginId } : {}),
    ...(info.purpose ? { purpose: info.purpose } : {}),
  });
}

function usageObservation(record: AgentUsageRecord) {
  return Object.freeze({
    inputTokens: record.inputTokens ?? 0,
    outputTokens: record.outputTokens ?? 0,
    ...(record.cachedInputTokens === undefined ? {} : { cachedInputTokens: record.cachedInputTokens }),
    ...(record.totalTokens === undefined ? {} : { totalTokens: record.totalTokens }),
    ...(record.model ? { model: record.model } : {}),
  });
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

/**
 * 压缩事件里的「大小」口径：条数 + 字符数。
 *
 * 字符数按字符串叶子累加而不是 `JSON.stringify` 整条消息：多模态结果里带着整张图的
 * base64，序列化一遍既撑内存，也不是「提示词里到底有多少文字」。
 */
function measureMessages(messages: unknown[]): { count: number; chars: number } {
  let chars = 0;
  const seen = new Set<unknown>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      chars += value.length;
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    for (const item of Object.values(value as Record<string, unknown>)) walk(item);
  };
  walk(messages);
  return { count: messages.length, chars };
}

export class AgentRuntime {
  readonly events = mitt<AgentRuntimeEvents>();
  private readonly rollbackConsumers = new Set<{
    text: (text: string) => void;
    start: () => void;
    rollback: () => void;
    thinking?: (text: string) => void;
  }>();
  private rollbackSafetyLost = false;
  private rollbackTracking = false;
  private rollbackCheck: (() => boolean) | undefined;
  readonly taskOwnerId = micaCommon.createId('agent-runtime');
  private client: IAgent<ModelClientOptions> | null = null;
  private runId = 0;
  /**
   * 子运行（委派子代理 + helper）的负数序号。
   *
   * 这些运行不在这个 runtime 的 turn loop 里，却又必须被 `agent:observe` 看见（否则
   * 委派树只能靠父侧那一次工具调用反推，插件自己的模型请求则完全没有出处）。负数让
   * 它们与主运行的轮次 id 永不相撞，`isCurrent` 也照旧只认正数的那一轮。
   */
  private childRunSeq = 0;
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
  private turnTimings: TurnTimingRecord[] = [];
  private activeTurnTiming: TurnTimingState | null = null;
  private activeTurnTimingRunId: number | null = null;
  private interruptedThinking: InterruptedThinking | undefined;
  private pendingThinking = '';
  private completedThinking = '';
  private thinkingAttemptStart = '';
  private completedThinkingAttemptStart = '';
  private thinkingNeedsSeparator = false;
  private thinkingAttemptNeedsSeparator = false;
  private turnAttemptThinking: InterruptedThinking | undefined;
  private activeTurn: { runId: number; input: AgentQueryContent; committed: boolean } | undefined;

  constructor(
    configOverride: AgentRuntimeConfigOverride = {},
    private readonly hooks?: HookRegistry,
    /** 同一宿主的会话共享插件登记，段落每轮从活动会话重新渲染。 */
    readonly promptSections = new PluginPromptSections(),
  ) {
    this.currentConfig = readAgentRuntimeConfig(configOverride);
    this.recreateClient();
    // The hosts emit these around each whole-turn attempt. The UI and the
    // runtime must restore the same pre-turn checkpoint when a retry is safe.
    this.events.on('thinkingTurnAttemptStart', () => {
      this.turnAttemptThinking = this.interruptedThinking && { ...this.interruptedThinking };
    });
    this.events.on('thinkingTurnAttemptRollback', () => {
      this.interruptedThinking = this.turnAttemptThinking && { ...this.turnAttemptThinking };
      this.pendingThinking = this.interruptedThinking?.text ?? '';
      this.completedThinking = this.pendingThinking;
      this.thinkingNeedsSeparator = Boolean(this.pendingThinking);
      this.thinkingAttemptStart = this.pendingThinking;
      this.completedThinkingAttemptStart = this.completedThinking;
      this.thinkingAttemptNeedsSeparator = this.thinkingNeedsSeparator;
    });
  }

  /** Register the three listeners belonging to one rollback-capable text consumer. */
  registerTextRollbackConsumer(consumer: {
    text: (text: string) => void;
    start: () => void;
    rollback: () => void;
    thinking?: (text: string) => void;
  }): () => void {
    this.rollbackConsumers.add(consumer);
    return () => {
      this.rollbackConsumers.delete(consumer);
    };
  }

  private canRollbackText(): boolean {
    const text = this.events.all.get('text') ?? [];
    const starts = this.events.all.get('textAttemptStart') ?? [];
    const rollbacks = this.events.all.get('textRollback') ?? [];
    if (!text.length || this.events.all.get('*')?.length) return false;
    return text.every((handler) => {
      const matches = [...this.rollbackConsumers].filter((consumer) => consumer.text === handler);
      return (
        matches.length === 1 &&
        starts.includes(matches[0]!.start) &&
        rollbacks.includes(matches[0]!.rollback) &&
        text.filter((candidate) => candidate === handler).length === 1
      );
    });
  }

  private canRollbackThinking(): boolean {
    const listeners = this.events.all.get('thinking') ?? [];
    return listeners.every((handler) => {
      const matches = [...this.rollbackConsumers].filter((consumer) => consumer.thinking === handler);
      return matches.length === 1 && listeners.filter((candidate) => candidate === handler).length === 1;
    });
  }

  get config() {
    return this.currentConfig;
  }

  get role() {
    // 报**配置里的名字**，不是解析出来的那份：插件角色还没发布时解析会落到默认角色，
    // 用它覆盖名字会把「暂时查不到」变成「这个会话是默认角色」，保存一次就真丢了。
    return this.currentRole;
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

  /**
   * 建一个子代理客户端。
   *
   * `observation` 由宿主在**派发**时给出：委派子代理带类型名与派生它的会话，helper
   * （压缩摘要、旁问线程）带一个稳定的来源短名。子代理跑在自己的客户端里、不经过这个
   * runtime 的 turn loop，不给它补一对 run 事件，观察方就只剩父侧那一次工具调用——
   * 拼不出委派树，也答不了「哪种类型的子代理回报最差」「摘要助手花了多少」。
   */
  createSubAgent(options: Partial<ModelClientOptions> = {}, observation: AgentSubagentObservation = {}) {
    if (!this.isConfigured) {
      const message = `${this.currentConfig.provider.id} 未配置 api_key，运行 /config 命令配置后再尝试`;
      throw new Error(message);
    }
    const child = micaAgent.createSubAgent({
      ...this.createClientOptions(options),
      effort: options.effort ?? 'none',
    });
    // 没说是哪一种也算 helper：宁可分类粗一点，也不要让一次真实的模型开销从轨迹里消失。
    const marker: RunMarker = observation.delegation
      ? { delegation: observation.delegation }
      : { helper: observation.helper ?? { kind: 'subagent' } };
    return this.observeChildRun(child, marker, options);
  }

  /**
   * 让一次「不经过 turn loop」的宿主工作也进观察流：插件经 `ctx.llm` 问模型（起标题、
   * 写提交说明、整理记忆）走的就是这条。
   *
   * 调用方把 `callbacks` 交给模型客户端（`runModelTextRequest` 的 `onRequestStart` /
   * `onRequestEnd`），并在 `finally` 里调一次 `finish()`：没有 finish 的运行会一直挂在
   * `running`，只能等宿主退出后才被回收。
   */
  startHelperRun(
    info: AgentHelperObservation & { model?: string; providerId?: string; protocol?: string; input?: unknown },
  ): HelperRunHandle {
    const observed: ObservedRun = { runId: -++this.childRunSeq, closed: false };
    const startedAt = Date.now();
    if (this.hooks) {
      this.observe(observed, {
        type: 'run:start',
        input: cloneJson(info.input),
        config: Object.freeze({
          providerId: info.providerId ?? this.currentConfig.provider.id,
          protocol: info.protocol ?? this.currentConfig.provider.protocol,
          model: info.model ?? this.currentConfig.model,
          effort: 'none',
          role: this.currentRole,
        }),
        helper: freezeHelper(info),
      });
    }
    return {
      callbacks: {
        onRequestStart: (request) => {
          this.observe(observed, {
            type: 'request:start',
            messageCount: request.messageCount,
            ...(request.tools === undefined ? {} : { tools: cloneJson(request.tools) }),
          });
        },
        onRequestEnd: (request) => this.observe(observed, { type: 'request:end', ...request }),
        onRetry: (request) =>
          this.observe(observed, {
            type: 'retry',
            attempt: request.attempt,
            delayMs: request.delayMs,
            error: errorMessageOf(request.error),
          }),
      },
      finish: (outcome, error, usage) => {
        if (observed.closed) return;
        for (const record of usage ?? []) this.observe(observed, { type: 'usage', usage: usageObservation(record) });
        observed.closed = true;
        this.observe(observed, {
          type: 'run:finish',
          outcome,
          elapsedMs: Date.now() - startedAt,
          ...(error === undefined ? {} : { error: errorMessageOf(error) }),
        });
      },
    };
  }

  /**
   * 在子客户端 `query` 两侧补一对 `run:start` / `run:finish`，并带上 `delegation` 或
   * `helper` 分类；请求与工具事件也从这里转发，否则子代理内部请求的耗时、
   * 首字延迟与工具结果都没有出处。
   *
   * 子运行用负数 runId，且整段包在自己的 AsyncLocalStorage 作用域里：子代理内部触发
   * 的观察不会落到父运行头上，父运行的 request 计数也不会被子代理的请求污染。
   */
  private observeChildRun(
    child: IAgent<ModelClientOptions>,
    marker: RunMarker,
    options: Partial<ModelClientOptions>,
  ): IAgent<ModelClientOptions> {
    if (!this.hooks) return child;
    const query = child.query.bind(child);
    const delegation = marker.delegation
      ? Object.freeze({
          type: marker.delegation.type,
          ...(marker.delegation.parentSessionId ? { parentSessionId: marker.delegation.parentSessionId } : {}),
        })
      : undefined;
    const helper = marker.helper ? freezeHelper(marker.helper) : undefined;
    child.query = async (question, queryOptions) => {
      const observed: ObservedRun = { runId: -++this.childRunSeq, closed: false };
      const startedAt = Date.now();
      const usageStart = child.usageHistory?.length ?? 0;
      let outcome: 'completed' | 'aborted' | 'error' = 'completed';
      let observationError: string | undefined;
      this.observe(observed, {
        type: 'run:start',
        input: cloneJson(question),
        config: Object.freeze({
          providerId: options.provider?.id ?? this.currentConfig.provider.id,
          protocol: options.provider?.protocol ?? this.currentConfig.provider.protocol,
          model: child.model,
          effort: options.effort ?? 'none',
          role: this.currentRole,
        }),
        ...(delegation ? { delegation } : {}),
        ...(helper ? { helper } : {}),
      });
      // The host installs activity callbacks before query; wrap those callbacks for this run
      // rather than replacing them when the child is created (or losing later replacements).
      const previousOnToolCall = child.onToolCall;
      const previousOnToolResult = child.onToolResult;
      const onToolCall: NonNullable<typeof child.onToolCall> = (name, args, id) => {
        if (!observed.closed) this.observe(observed, { type: 'tool:call', name, args, id });
        previousOnToolCall?.(name, args, id);
      };
      const onToolResult: NonNullable<typeof child.onToolResult> = (name, result, id) => {
        if (!observed.closed) this.observe(observed, { type: 'tool:result', name, result, id });
        previousOnToolResult?.(name, result, id);
      };
      child.onToolCall = onToolCall;
      child.onToolResult = onToolResult;
      try {
        return await this.observationScope.run(observed, () =>
          query(question, {
            ...queryOptions,
            onRequestStart: (info) => {
              this.observe(observed, {
                type: 'request:start',
                messageCount: info.messageCount,
                ...(info.tools === undefined ? {} : { tools: cloneJson(info.tools) }),
              });
              queryOptions?.onRequestStart?.(info);
            },
            onRequestEnd: (info) => {
              this.observe(observed, { type: 'request:end', ...info });
              queryOptions?.onRequestEnd?.(info);
            },
            onRetry: (info) => {
              this.observe(observed, {
                type: 'retry',
                attempt: info.attempt,
                delayMs: info.delayMs,
                error: errorMessageOf(info.error),
              });
              queryOptions?.onRetry?.(info);
            },
          }),
        );
      } catch (error) {
        outcome = isAbortError(error) || queryOptions?.signal?.aborted ? 'aborted' : 'error';
        observationError = errorMessageOf(error);
        throw error;
      } finally {
        if (child.onToolCall === onToolCall) child.onToolCall = previousOnToolCall;
        if (child.onToolResult === onToolResult) child.onToolResult = previousOnToolResult;
        // `loadSnapshot` 会整份替换 usageHistory：长度比开始时还短说明记录被换过，
        // 这时宁可不报用量，也不要把前一次查询的账重复算一遍。
        const history = child.usageHistory ?? [];
        for (const record of history.length >= usageStart ? history.slice(usageStart) : [])
          this.observe(observed, { type: 'usage', usage: usageObservation(record) });
        observed.closed = true;
        this.observe(observed, {
          type: 'run:finish',
          outcome,
          elapsedMs: Date.now() - startedAt,
          ...(observationError === undefined ? {} : { error: observationError }),
        });
      }
    };
    return child;
  }

  /**
   * 一次「迭代边界上的压缩」，即插件经 `ctx.agent.compact` 调用的那条路。
   *
   * `history:rewritten` 只说明历史被改过，答不出是本地清理、模型摘要还是插件重写；
   * 压缩事件在**压缩之后**发，带上前后的条数与字符数，观察方才能按策略与原因归并成本。
   * 「没有可清理内容」也发一条 `applied: false`（这次检查后决定不压），但异常照旧抛回
   * 插件——它据此决定要不要升级到模型摘要。
   *
   * 观察失败不影响压缩：`observe` 走 hook 通知，抛错与永不完成的 Promise 都被隔离。
   */
  async compactIterationMessages(
    messages: unknown[],
    options: PluginCompactOptions & { pluginId?: string; signal?: AbortSignal },
  ): Promise<PluginCompactResult> {
    const before = measureMessages(messages);
    const { pluginId, ...compactOptions } = options;
    const report = (next: unknown[], applied: boolean): void => {
      const after = measureMessages(next);
      this.observeActive({
        type: 'compaction',
        // 传了 `summarize`（或直接要模型摘要）就是模型写的摘要；其余一律按本地清理。
        strategy: compactOptions.mode === 'model' || compactOptions.summarize ? 'llm' : 'local',
        reason: pluginId ? `iteration:${pluginId}` : 'iteration',
        beforeMessages: before.count,
        afterMessages: after.count,
        beforeChars: before.chars,
        afterChars: after.chars,
        applied: applied && (after.count !== before.count || after.chars !== before.chars),
      });
    };
    let result: PluginCompactResult;
    try {
      result = await compactAgentMessages(this, messages, compactOptions);
    } catch (error) {
      if (isNothingToCompact(error)) report(messages, false);
      throw error;
    }
    report(result.messages, true);
    return result;
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
    const role = this.resolveCurrentRole();
    const prompt = micaAgent.buildSystemPrompt({
      rolePrompt: role.name === DEFAULT_ROLE_NAME ? undefined : role.prompt,
      skills: this.availableSkills(),
    });
    // 插件段落固定追加在最末：它们才是「每轮可能变」的内容（会话笔记、循环说明），
    // 放在最后才不会让前面稳定的 system / AGENT.md / skills / context 跟着一起失效。
    const pluginSections = this.promptSections.render();
    return pluginSections ? `${prompt}\n\n${pluginSections}` : prompt;
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
    const previousSnapshot = !resetSession ? this.client?.getSnapshot() : null;
    if (resetSession) {
      this.runId++;
    }
    this.currentConfig = readAgentRuntimeConfig();
    const thinkingModelChanged = this.interruptedThinking && !this.matchesThinkingModel(this.interruptedThinking);
    if (resetSession || thinkingModelChanged) {
      this.interruptedThinking = undefined;
      if (thinkingModelChanged) this.events.emit('thinkingReset', undefined);
    }
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

  configureForRun(override: AgentRuntimeConfigOverride, preserveSession = true): void {
    if (this.isRunning) {
      throw new Error('Cannot configure agent while it is running');
    }
    const previousSnapshot = preserveSession ? this.client?.getSnapshot() : null;
    const providerId = override.providerId ?? this.currentConfig.provider.id;
    const next = readAgentRuntimeConfig({
      providerId,
      model: override.model ?? (providerId === this.currentConfig.provider.id ? this.currentConfig.model : undefined),
      effort: override.effort ?? this.currentConfig.effort,
    });
    this.currentConfig = next;
    if (this.interruptedThinking && (!preserveSession || !this.matchesThinkingModel(this.interruptedThinking))) {
      this.interruptedThinking = undefined;
      this.events.emit('thinkingReset', undefined);
    }
    this.recreateClient();
    if (previousSnapshot && this.client) {
      this.client.loadSnapshot({ ...previousSnapshot, model: next.model });
    }
  }

  abort() {
    // Invalidate runId only after the UI has rolled back the unfinished request.
    if (this.activeAbortController) {
      this.rollbackIncompleteThinking();
    }
    this.runId++;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.emitStatus({ type: 'idle' });
  }

  private rollbackIncompleteThinking(): void {
    this.interruptedThinking = this.completedThinking
      ? this.makeInterruptedThinking(this.completedThinking)
      : undefined;
    this.pendingThinking = this.completedThinking;
    this.events.emit('thinkingRollback', undefined);
  }

  /** Drop a display checkpoint after the conversation it describes is rewritten. */
  clearInterruptedThinking(): void {
    if (!this.interruptedThinking) return;
    this.interruptedThinking = undefined;
    this.events.emit('thinkingReset', undefined);
  }

  reserveRunId(): number {
    return ++this.runId;
  }

  clearSession() {
    this.runId++;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.client?.reset();
    this.interruptedThinking = undefined;
    this.pendingThinking = '';
    this.completedThinking = '';
    this.activeTurn = undefined;
    // /clear 与新建会话都是「这条会话从这里重来」：插件状态属于会话，跟着一起清掉，
    // 否则新会话会莫名其妙继承上一轮的结论。
    this.pluginState = {};
    this.pluginSessionSettings = {};
    // 耗时记录属于这条会话发生过的轮次，新会话从空开始。
    this.turnTimings = [];
    this.activeTurnTiming = null;
    this.activeTurnTimingRunId = null;
    // 记下来的提示词也属于这条会话：新会话的第一轮请求会重新记录。
    this.lastSystemPrompt = undefined;
    this.emitStatus({ type: 'idle' });
  }

  getLastUsage(): AgentUsageRecord | undefined {
    return this.client?.lastUsage;
  }

  /** The prompt and tool schemas share the provider's context budget. */
  estimateRequestOverheadTokens(): number {
    return (
      estimateTextTokens(this.systemPrompt ?? '') +
      estimateTextTokens(JSON.stringify(micaTools.getDefinitions(this.isToolEnabledByCapabilities)))
    );
  }

  get systemPrompt(): string | undefined {
    return this.lastSystemPrompt;
  }

  getSnapshot(): AgentRuntimeSnapshot {
    // 持久化使用已有的展示记录，不必再把完整 provider 历史投影为展示消息。
    const snapshot = this.client?.getSnapshot({ includeConversation: false });
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
      messageFormat: 'pi-ai-v1',
      messages: (snapshot?.messages ?? []) as Message[],
      usageHistory: snapshot?.usageHistory ?? [],
      lastUsage: snapshot?.lastUsage,
      ...(this.interruptedThinking ? { interruptedThinking: { ...this.interruptedThinking } } : {}),
      ...(this.isRunning && this.completedThinking
        ? { activeThinking: this.makeInterruptedThinking(this.completedThinking) }
        : {}),
      ...(this.isRunning && this.activeTurn
        ? { activeTurn: { input: cloneJson(this.activeTurn.input), committed: this.activeTurn.committed } }
        : {}),
      subagentUsageHistory: this.subagentUsageHistory,
      turnTimings: this.turnTimings,
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
      interruptedThinking: options.dropLastUserMessageAndAfter ? undefined : snapshot.interruptedThinking,
      // The fork is not running the source turn. In particular, a fork that
      // removes that turn must never retain its active display checkpoint.
      activeThinking: undefined,
      activeTurn: undefined,
      usageHistory: [],
      lastUsage: snapshot.lastUsage,
      subagentUsageHistory: [],
      // 耗时记录描述的是源会话跑过的轮次；fork 出来的新会话从自己的第一轮重新记。
      turnTimings: [],
    };
  }

  preserveAbortedTurn(question: AgentQueryContent, partialAnswer?: string) {
    if (!this.client) return false;
    this.trimAbortedRunUsage();
    const hadCurrentTurn = this.client.preserveAbortedTurn(question, partialAnswer);
    return hadCurrentTurn;
  }

  captureClientSnapshot() {
    if (!this.client) return null;
    // 回滚只使用 provider 状态。跳过展示投影与 JSON 文本中间副本；一次 clone 也会
    // 保留 lastUsage 与 usageHistory 尾项的共享引用，而不是复制两遍。
    return structuredClone({
      messageFormat: 'pi-ai-v1' as const,
      model: this.client.model,
      messages: this.client.messages,
      usageHistory: this.client.usageHistory,
      lastUsage: this.client.lastUsage,
    });
  }

  restoreClientSnapshot(snapshot: Omit<AgentSnapshot<unknown, AgentUsageRecord>, 'conversationMessages'>) {
    // 只有真正回滚时才再复制。provider 会追加 usage，不能污染下一次重试的原始基线。
    this.client?.loadSnapshot({ ...structuredClone(snapshot), conversationMessages: [] });
  }

  loadSnapshot(snapshot: AgentRuntimeSnapshot, options: { recoverActiveThinking?: boolean } = {}) {
    if (this.isRunning) {
      throw new Error('Cannot load snapshot while agent is running');
    }
    if (snapshot.messageFormat !== PI_MESSAGE_FORMAT) throw new Error(PI_MESSAGE_FORMAT_ERROR);
    this.runId++;
    this.currentConfig = agentRuntimeConfigFromSnapshot(snapshot);
    const recovered = options.recoverActiveThinking ? snapshot.activeThinking : undefined;
    const thinking = recovered && this.matchesThinkingModel(recovered) ? recovered : snapshot.interruptedThinking;
    this.interruptedThinking = thinking && this.matchesThinkingModel(thinking) ? { ...thinking } : undefined;
    this.pendingThinking = '';
    this.completedThinking = '';
    this.activeTurn = undefined;
    // 名字照抄，**不**在解析不到时改写成默认角色：插件角色由插件发布索引（`plugin-roles/`），
    // 而插件是在这个快照加载之后才 setup 的，那一刻查不到很正常。在这里改成 default 会
    // 把「还没来得及发布」变成「这个会话从此是默认角色」——下一次保存就真的写进会话了。
    this.currentRole =
      typeof snapshot.role === 'string' && snapshot.role.trim() ? snapshot.role.trim() : DEFAULT_ROLE_NAME;
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
      messageFormat: 'pi-ai-v1',
      model: this.currentConfig.model,
      messages: snapshot.messages,
      usageHistory: snapshot.usageHistory,
      lastUsage: snapshot.lastUsage,
      conversationMessages: [],
    });
    if (options.recoverActiveThinking && snapshot.activeTurn && !snapshot.activeTurn.committed && this.client) {
      // loadSnapshot resets the provider's per-turn committed flag. The saved
      // flag describes these exact messages, including after tool iterations.
      const alreadyAtTail = this.client.preserveAbortedTurn(snapshot.activeTurn.input);
      if (alreadyAtTail) {
        // A matching unanswered previous message is still a separate turn: the
        // saved input is known not to have been committed to these messages.
        const current = this.client.getSnapshot();
        const last = current.messages.at(-1);
        if (last !== undefined)
          this.client.loadSnapshot({ ...current, messages: [...current.messages, cloneJson(last)] });
      }
    }
    this.subagentUsageHistory = snapshot.subagentUsageHistory ?? [];
    this.turnTimings = normalizeTurnTimings(snapshot.turnTimings);
    this.activeTurnTiming = null;
  }

  /** Recover a crashed turn without reloading unrelated in-memory settings. */
  recoverActiveThinking(thinking: InterruptedThinking): boolean {
    if (this.isRunning || !this.matchesThinkingModel(thinking)) return false;
    this.interruptedThinking = { ...thinking };
    return true;
  }

  toConversationMessages(): MicaUiConversationMessage[] {
    return this.client?.toConversationMessages() ?? [];
  }

  async run(question: AgentQueryContent, options: AgentRunOptions = {}): Promise<{ runId: number; text: string }> {
    const runId = options.reservedRunId ?? ++this.runId;
    const startedAt = Date.now();
    this.activeTurnTiming = applyTurnTimingTick(createTurnTimingState(), { type: 'turn-start', at: startedAt });
    this.activeTurnTimingRunId = runId;
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
      this.activeTurn = { runId, input: cloneJson(question), committed: false };
      this.activeRunStartedAt = startedAt;
      this.activeRunUsageStartIndex = this.client.usageHistory.length;
      this.activeRunCompleteUsageLength = this.client.usageHistory.length;
      this.abortedRunUsageStartIndex = null;
      this.abortedRunCompleteUsageLength = null;
      this.pendingThinking = this.interruptedThinking?.text ?? '';
      this.completedThinking = this.pendingThinking;
      this.thinkingAttemptStart = this.pendingThinking;
      this.completedThinkingAttemptStart = this.completedThinking;
      this.thinkingNeedsSeparator = Boolean(this.pendingThinking);
      this.thinkingAttemptNeedsSeparator = this.thinkingNeedsSeparator;
      this.emitStatus({ type: 'connecting', startedAt });
      const client = this.client;
      const rollbackEnabled = this.canRollbackText();
      const initialTextListeners = [...(this.events.all.get('text') ?? [])];
      const initialThinkingListeners = [...(this.events.all.get('thinking') ?? [])];
      const thinkingRollbackEnabled = rollbackEnabled && this.canRollbackThinking();
      client.canRollbackThinking = thinkingRollbackEnabled;
      const initialConsumers = [...this.rollbackConsumers];
      this.rollbackCheck = () =>
        this.canRollbackText() &&
        initialTextListeners.length === (this.events.all.get('text')?.length ?? 0) &&
        initialTextListeners.every((handler, index) => this.events.all.get('text')?.[index] === handler) &&
        (!thinkingRollbackEnabled ||
          (this.canRollbackThinking() &&
            initialThinkingListeners.length === (this.events.all.get('thinking')?.length ?? 0) &&
            initialThinkingListeners.every(
              (handler, index) => this.events.all.get('thinking')?.[index] === handler,
            ))) &&
        initialConsumers.length === this.rollbackConsumers.size &&
        initialConsumers.every((consumer) => this.rollbackConsumers.has(consumer));
      this.rollbackTracking = rollbackEnabled;
      this.rollbackSafetyLost = false;
      client.onTextAttemptStart = rollbackEnabled
        ? () => {
            if (!this.isCurrent(runId)) return;
            if (!this.rollbackCheck?.()) throw new Error('Text rollback consumers changed during the run');
            this.thinkingAttemptStart = this.pendingThinking;
            this.completedThinkingAttemptStart = this.completedThinking;
            this.thinkingAttemptNeedsSeparator = this.thinkingNeedsSeparator;
            this.events.emit('textAttemptStart', undefined);
          }
        : undefined;
      client.onTextRollback = rollbackEnabled
        ? () => {
            if (!this.isCurrent(runId)) return;
            if (this.rollbackSafetyLost || !this.rollbackCheck?.())
              throw new Error('Text rollback consumers changed during the run');
            this.pendingThinking = this.thinkingAttemptStart;
            this.completedThinking = this.completedThinkingAttemptStart;
            this.thinkingNeedsSeparator = this.thinkingAttemptNeedsSeparator;
            this.events.emit('textRollback', undefined);
          }
        : undefined;
      client.onThinkingCheckpoint = () => {
        if (!this.isCurrent(runId)) return;
        this.completedThinking = this.pendingThinking;
        // Pi supplies separators for blocks and later requests in the same run.
        // The runtime only separates a restored checkpoint from the next run.
        this.events.emit('thinkingCheckpoint', undefined);
      };
      const signal = abortController.signal;
      let rewrittenInputWillCommit = false;
      const text = await this.observationScope.run(observed, () =>
        client.query(question, {
          signal,
          shouldContinue: () => this.isCurrent(runId),
          maxTurns: options.maxTurns,
          onRequestStart: (info) => {
            if (!this.isCurrent(runId)) return;
            if (rewrittenInputWillCommit && this.activeTurn?.runId === runId) {
              this.activeTurn.committed = true;
              rewrittenInputWillCommit = false;
            }
            this.observeActive({
              type: 'request:start',
              messageCount: info.messageCount,
              ...(info.tools === undefined ? {} : { tools: cloneJson(info.tools) }),
            });
          },
          onRequestEnd: (info) => {
            if (!this.isCurrent(runId)) return;
            // 请求级耗时：turn 级的 `run:finish` 只说整轮花了多久，回答不了「这一轮是
            // 排队久、还是首字慢、还是重试拖的」。观察方据此算 TTFT 与重试代价。
            this.observeActive({ type: 'request:end', ...info });
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
              // The provider installs these messages after this callback. Mark
              // them committed only when it reports the next request start.
              rewrittenInputWillCommit = true;
              this.observeActive({ type: 'history:rewritten', beforeCount, afterCount: rewritten.length });
            }
            return rewritten;
          },
          onIterationComplete: async () => {
            if (!this.isCurrent(runId)) return null;
            this.activeRunCompleteUsageLength = this.client?.usageHistory.length ?? this.activeRunCompleteUsageLength;
            if (this.activeTurn?.runId === runId) this.activeTurn.committed = true;
            const nextInput = await (options.onIterationComplete?.() ?? null);
            if (nextInput != null && this.isCurrent(runId) && this.activeTurn?.runId === runId) {
              this.activeTurn = { runId, input: cloneJson(nextInput), committed: false };
            }
            return nextInput;
          },
        }),
      );
      if (!this.isCurrent(runId) || signal.aborted) outcome = 'aborted';
      if (this.isCurrent(runId)) {
        this.interruptedThinking = undefined;
        // Completed status listeners can synchronously request a snapshot before
        // the finally block clears the active controller.
        this.completedThinking = '';
        this.activeTurn = undefined;
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
      if (abortController) {
        this.rollbackIncompleteThinking();
      }
      if (this.isCurrent(runId)) this.emitStatus({ type: 'error', message });
      throw error;
    } finally {
      if (this.activeTurn?.runId === runId) this.activeTurn = undefined;
      if (abortController && this.activeAbortController === abortController) {
        this.activeAbortController = null;
        this.rollbackTracking = false;
        this.rollbackCheck = undefined;
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
      this.finishTurnTiming(outcome, runId);
    }
  }

  isCurrent(runId: number) {
    return runId === this.runId;
  }

  /** 记一段耗时；没有在跑的轮次（例如已清空会话）就丢掉。 */
  private noteTurnTiming(tick: TurnTimingTick): void {
    if (!this.activeTurnTiming) return;
    this.activeTurnTiming = applyTurnTimingTick(this.activeTurnTiming, tick);
  }

  /** 工具行上那句说明（`run_shell` 显示的就是它跑的那条命令）。 */
  private toolDisplayText(name: string, args: unknown): string {
    try {
      const input = typeof args === 'string' ? (args.trim() ? JSON.parse(args) : {}) : (args ?? {});
      return micaTools.getDisplayText(name, input as Record<string, unknown>);
    } catch {
      return '';
    }
  }

  /**
   * 收尾本轮并归档。
   *
   * 只在 `runId` 还是当初记这条记录的那个轮次时才归档：`clearSession()` 会自增
   * `runId` 并中断，被中断那一轮的 finally 随后才跑到这里，不能把上一轮的耗时记进
   * 新会话。
   */
  private finishTurnTiming(outcome: TurnTimingOutcome, runId: number): void {
    const state = this.activeTurnTiming;
    // 记录不属于这一轮就不要碰它：`clearSession()` 已经换上（或清掉）新的记录，被中断
    // 那一轮的 finally 是后到的，把上一轮的耗时归档进新会话就成了无主数据。
    if (this.activeTurnTimingRunId !== runId) return;
    this.activeTurnTiming = null;
    this.activeTurnTimingRunId = null;
    if (!state) return;
    const record = turnTimingRecord(applyTurnTimingTick(state, { type: 'turn-end', at: Date.now(), outcome }));
    // 一个区间都没跑出来的轮次（起步就失败、配置缺失）没有「时间去哪了」可看。
    if (!record || !record.segments.length) return;
    this.turnTimings = appendTurnTiming(this.turnTimings, record);
  }

  private makeInterruptedThinking(text: string): InterruptedThinking {
    return {
      providerId: this.currentConfig.provider.id,
      protocol: this.currentConfig.provider.protocol,
      model: this.currentConfig.model,
      apiBase: this.currentConfig.provider.api_base,
      text,
    };
  }

  private matchesThinkingModel(thinking: InterruptedThinking): boolean {
    return (
      typeof thinking.text === 'string' &&
      thinking.text.length > 0 &&
      thinking.providerId === this.currentConfig.provider.id &&
      thinking.protocol === this.currentConfig.provider.protocol &&
      thinking.model === this.currentConfig.model &&
      thinking.apiBase === this.currentConfig.provider.api_base
    );
  }

  private recreateClient() {
    if (!this.currentConfig.provider.api_key) {
      this.client = null;
      return;
    }
    this.client = micaAgent.createModelClient(this.clientOptions());
    this.client.onText = (text) => {
      if (this.rollbackTracking && !this.rollbackCheck?.()) this.rollbackSafetyLost = true;
      this.noteTurnTiming({ type: 'output', at: Date.now(), chars: typeof text === 'string' ? text.length : 0 });
      this.emitStatus({ type: 'streaming', startedAt: this.activeRunStartedAt ?? undefined });
      this.events.emit('text', text);
      if (this.rollbackTracking && !this.rollbackCheck?.()) this.rollbackSafetyLost = true;
    };
    this.client.onThinking = (thinking) => {
      if (this.rollbackTracking && !this.rollbackCheck?.()) this.rollbackSafetyLost = true;
      this.noteTurnTiming({
        type: 'output',
        at: Date.now(),
        chars: typeof thinking === 'string' ? thinking.length : 0,
      });
      if (thinking) {
        if (this.thinkingNeedsSeparator) this.pendingThinking += '\n\n';
        this.pendingThinking += thinking;
        this.thinkingNeedsSeparator = false;
      }
      this.emitStatus({ type: 'thinking', startedAt: this.activeRunStartedAt ?? undefined });
      this.events.emit('thinking', thinking);
      if (this.rollbackTracking && !this.rollbackCheck?.()) this.rollbackSafetyLost = true;
    };
    this.client.onToolCall = (name, args, id) => {
      this.noteTurnTiming({
        type: 'tool-start',
        at: Date.now(),
        tool: name,
        callID: id,
        displayText: this.toolDisplayText(name, args),
      });
      this.observeActive({ type: 'tool:call', name, args, id });
      this.emitStatus({ type: 'calling_tool', startedAt: this.activeRunStartedAt ?? undefined, toolNames: [name] });
      this.events.emit('toolCall', { name, args, id });
    };
    this.client.onToolResult = (name, result, id) => {
      this.noteTurnTiming({ type: 'tool-end', at: Date.now(), callID: id, status: 'completed' });
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
    // 子运行（负数 runId）不在主轮次的 runId 序列里，但它自己那段 scope 里发出的
    // 事件同样属于它：只按 `closed` 判定，否则子运行永远观察不到自己的 request。
    if (!observed || observed.closed) return;
    if (observed.runId > 0 && !this.isCurrent(observed.runId)) return;
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
    // 解析不到就把名字留着（插件角色稍后才发布）：提示词用默认的那份，但会话角色不变，
    // 插件按角色做的门控也因此仍然成立。名字被**改写**才是真的丢配置。
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
