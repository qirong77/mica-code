import type {
  AgentQueryContent,
  AgentUsageRecord,
  AgentUsageSummary,
  SubagentUsageRecord,
} from '@packages/mica-agent/index.js';
import type { EffortOption, ProviderDefinition } from '@packages/mica-config/index.js';
import type { CompactOptions, CompactResult } from '@packages/mica-context/index.js';
import type {
  RewindApplyRequest,
  RewindApplyResult,
  RewindCheckpointSummary,
  RewindPreviewResult,
  SubmitResult,
} from '@packages/mica-runtime/index.js';
import type { MicaUiWorkingStatus } from '@packages/mica-ui/index.js';
import type { AutoCompactOverride, CapabilitySelection } from '@packages/mica-common/index.js';

export type {
  RewindApplyRequest,
  RewindApplyResult,
  RewindCheckpointSummary,
  RewindFileChange,
  RewindMode,
  RewindPreviewResult,
} from '@packages/mica-runtime/index.js';

export type CommandProvider = ProviderDefinition & { contextWindowSize: number };

export type CommandAgent = {
  readonly taskOwnerId?: string;
  readonly config: {
    provider: CommandProvider;
    model: string;
    effort: string;
  };
  readonly currentRunId: number;
  readonly isRunning: boolean;
  readonly role: string;
  readonly capabilitySelection?: CapabilitySelection;
  /** 本会话的自动压缩覆盖（只含显式改过的键）；空对象表示完全跟随默认。 */
  readonly autoCompactOverrideSelection?: AutoCompactOverride;
  reloadConfig(resetClient?: boolean): void;
  setRole(roleName: string): void;
  setCapabilities?(selection: CapabilitySelection): CapabilitySelection;
  setAutoCompactOverride?(override: AutoCompactOverride): AutoCompactOverride;
  buildSystemPrompt(): string;
  createSubAgent(options?: { systemPrompt?: string | (() => string); [key: string]: unknown }): {
    /**
     * 问题可以是纯文本，也可以是文本 + 图片的多模态内容块（桌面端 By The Way 的粘贴
     * 图片走后者：`[Image](路径)` 由调用方解析成 content block 再传进来）。
     */
    query(input: AgentQueryContent): Promise<string>;
    /** 该子代理已发出的模型请求；命令据此把 helper 子代理的开销记进会话。 */
    readonly usageHistory?: AgentUsageRecord[];
    /**
     * 流式回调（与 `IAgent` 同款，可选设置）。桌面端的 By The Way 抽屉靠它们把
     * 思考 / 工具调用 / 正文实时推给界面——btw 就是一个 mica 运行实例，跑起来该和
     * 主对话一样是流式的。不设置时子代理照常只返回最终文本（CLI 的 `/btw`、
     * commit 消息、compact 摘要都不设置）。
     */
    onText?: (text: string) => void;
    onThinking?: (thinking: string) => void;
    onToolCall?: (name: string, args: string, id?: string) => void;
    onToolResult?: (name: string, result: string, id?: string) => void;
  };
  /**
   * 把 helper 子代理（commit / btw / compact 摘要）的用量写进当前会话的
   * `subagentUsageHistory`。主请求仍走 `usageHistory`，两者不混。
   */
  recordSubagentUsage?(record: SubagentUsageRecord): void;
  getSnapshot(): {
    providerId: string;
    model: string;
    effort: string;
    role: string;
    messages: unknown[];
    lastUsage?: AgentUsageRecord;
    usageHistory: AgentUsageRecord[];
  };
};

export type SessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
  cwd: string;
  model: string;
  uncompleted: boolean;
};

export type ResumeSessionResult =
  | {
      ok: true;
      session: { title: string; cwd?: string; snapshot: { model: string } };
      roleFallback?: { missing: string; fallback: string };
    }
  | { ok: false; message: string };

export type CommandSessionController = {
  list(limit?: number): SessionSummary[];
  listRecent(limit?: number): SessionSummary[];
  load?(id: string): { cwd?: string; snapshot: { model: string } } | null;
  resume(id: string): ResumeSessionResult;
  startNewSession(): void;
  saveCurrent(options?: { allowEmpty?: boolean }): void;
  renameCurrent(title: string): void;
  getCurrentTitle?(): string | null;
  getCurrentSessionId?(): string;
};

export type RunningAgentRecord = {
  id: string;
  taskOwnerId?: string;
  index: number;
  title: string;
  cwd: string;
  providerId: string;
  providerName: string;
  model: string;
  status: MicaUiWorkingStatus;
  current: boolean;
  startedAt: string;
  updatedAt: string;
};

export type SubagentTaskStatus = 'running' | 'completed' | 'failed' | 'killed';

export type SubagentTaskOwner = {
  sessionId: string;
  index: number;
  title: string;
  current: boolean;
};

export type SubagentTaskSummary = {
  id: string;
  description: string;
  subagentType: string;
  model: string;
  effort: EffortOption;
  status: SubagentTaskStatus;
  startedAt: string;
  finishedAt?: string;
  owner: SubagentTaskOwner;
};

export type SubagentTaskDetail = SubagentTaskSummary & {
  prompt?: string;
  maxTurns?: number;
  contextMode?: 'none' | 'brief' | 'recent' | 'files';
  contextFiles: string[];
  ownedPaths: string[];
  writeMode?: 'none' | 'owned_paths' | 'proposal' | 'unrestricted';
  usage?: AgentUsageSummary;
  error?: string;
  result?: string;
};

export type ForkAgentResult = RunningAgentRecord & {
  sourceWasRunning: boolean;
};

export type ClearIdleAgentsResult = {
  cleared: RunningAgentRecord[];
  remaining: RunningAgentRecord[];
};

export type PluginStatusOptions = {
  ownerSessionId?: string;
  level?: 'info' | 'warn' | 'error';
  surface?: 'working_status' | 'command_panel';
  command?: string;
  variant?: 'commit' | 'config' | 'compact' | 'error';
};

export type ExclusiveTaskOptions = PluginStatusOptions & {
  statusText: string;
};

export type CommandNoticeOptions = {
  variant?: 'commit' | 'config' | 'compact' | 'error';
  command?: string;
  surface?: 'conversation' | 'command_panel';
  status?: 'running' | 'success' | 'warning' | 'error' | 'info';
};

export type CommandRuntimeServices = {
  clearUI(agent: CommandAgent, sessionController?: CommandSessionController): void;
  clearSubagentTasks?(agent: CommandAgent): number;
  showMessage(text: string, ttl?: number, ownerSessionId?: string): void;
  showNotice(text: string, ownerSessionId?: string, options?: CommandNoticeOptions): void;
  showCommitNotice(text: string, ownerSessionId?: string): void;
  setPluginStatus(agent: CommandAgent, text: string, options?: PluginStatusOptions): void;
  clearPluginStatus(agent: CommandAgent, ownerSessionId?: string): void;
  syncModelDisplay(agent: CommandAgent): void;
  ensureModelRule?(model: string): Promise<void>;
  startConfigWeb?(): Promise<{ url: string }>;
  isAgentRunning(): boolean;
  isAgentBusy(agent?: CommandAgent): boolean;
  hasBusyAgents?(): boolean;
  getCurrentAgentSessionId(): string | undefined;
  getCurrentAgent(): CommandAgent | undefined;
  getCurrentSessionController(): CommandSessionController | undefined;
  renameCurrentAgentSession(title: string): void;
  listRunningAgents(): RunningAgentRecord[];
  listSubagentTasks(): SubagentTaskSummary[];
  getSubagentTask(id: string): SubagentTaskDetail | undefined;
  clearIdleAgents(): ClearIdleAgentsResult;
  requestExit(exitCode?: number): Promise<void>;
  newAgentSession(): RunningAgentRecord;
  submitAgentSessionInput(
    id: string,
    text: string,
    options?: { queueMode?: 'after_iteration' | 'after_turn'; displayText?: string },
  ): Promise<SubmitResult>;
  forkCurrentAgent(): ForkAgentResult;
  switchAgentSession(id: string): RunningAgentRecord;
  refreshCurrentAgentSessionUi(): void;
  syncAgentStatusItems?(): void;
  listRewindCheckpoints(): RewindCheckpointSummary[];
  getRewindPreview(id?: string): RewindPreviewResult;
  applyRewind(request: RewindApplyRequest): RewindApplyResult;
  clearRewindCheckpoints?(): void;
  runExclusiveTask<T>(agent: CommandAgent, options: ExclusiveTaskOptions, task: () => Promise<T>): Promise<T>;
  compact(
    agent: CommandAgent,
    sessionController: CommandSessionController,
    ownerSessionId?: string,
    options?: CompactOptions,
  ): Promise<CompactResult>;
  applySessionHistory?(
    agent: CommandAgent,
    sessionController: CommandSessionController,
    ownerSessionId: string | undefined,
    options: { messages: unknown[]; beforeCount: number },
  ): Promise<{ beforeCount: number; afterCount: number }>;
};
