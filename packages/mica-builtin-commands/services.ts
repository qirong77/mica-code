import type { AgentUsageRecord, AgentUsageSummary } from '@packages/mica-agent/index.js';
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
  reloadConfig(resetClient?: boolean): void;
  setRole(roleName: string): void;
  buildSystemPrompt(): string;
  createSubAgent(options?: { systemPrompt?: string | (() => string); [key: string]: unknown }): {
    query(input: string): Promise<string>;
  };
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
      session: { title: string; snapshot: { model: string } };
      roleFallback?: { missing: string; fallback: string };
    }
  | { ok: false; message: string };

export type CommandSessionController = {
  list(limit?: number): SessionSummary[];
  listRecent(limit?: number): SessionSummary[];
  load?(id: string): { snapshot: { model: string } } | null;
  resume(id: string): ResumeSessionResult;
  startNewSession(): void;
  saveCurrent(): void;
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
  status?: 'success' | 'warning' | 'error' | 'info';
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
  submitAgentSessionInput(id: string, text: string): Promise<SubmitResult>;
  forkCurrentAgent(): ForkAgentResult;
  switchAgentSession(id: string): RunningAgentRecord;
  refreshCurrentAgentSessionUi(): void;
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
};
