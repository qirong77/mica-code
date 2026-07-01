import type { ProviderDefinition } from '@packages/mica-config/index.js';
import type { AgentUsageRecord } from '@packages/mica-agent/index.js';
import type { CompactOptions, CompactResult } from '@packages/mica-context/index.js';
import type { RewindApplyResult, RewindPreviewResult, SubmitResult } from '@packages/mica-runtime/index.js';
import type { MicaUiWorkingStatus } from '@packages/mica-ui/index.js';

export type { RewindApplyResult, RewindFileChange, RewindPreviewResult } from '@packages/mica-runtime/index.js';

export type CommandProvider = ProviderDefinition & { contextWindowSize: number };

export type CommandAgent = {
  readonly config: {
    provider: CommandProvider;
    model: string;
    effort: string;
  };
  readonly currentRunId: number;
  readonly isRunning: boolean;
  reloadConfig(resetClient?: boolean): void;
  createSubAgent(options?: { systemPrompt?: string; [key: string]: unknown }): {
    query(input: string): Promise<string>;
  };
  getSnapshot(): {
    providerId: string;
    model: string;
    effort: string;
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
};

export type ResumeSessionResult =
  | { ok: true; session: { title: string; snapshot: { model: string } } }
  | { ok: false; message: string };

export type CommandSessionController = {
  list(limit?: number): SessionSummary[];
  resume(id: string): ResumeSessionResult;
  startNewSession(): void;
  saveCurrent(): void;
  renameCurrent(title: string): void;
  getCurrentTitle?(): string | null;
};

export type RunningAgentRecord = {
  id: string;
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
};

export type ExclusiveTaskOptions = PluginStatusOptions & {
  statusText: string;
};

export type RecapOptions = {
  customInstructions?: string;
};

export type RecapResult = {
  summary: string;
  messageCount: number;
};

export type CommandRuntimeServices = {
  clearUI(agent: CommandAgent, sessionController?: CommandSessionController): void;
  showMessage(text: string, ttl?: number, ownerSessionId?: string): void;
  showNotice(text: string, ownerSessionId?: string): void;
  showCommitNotice(text: string, ownerSessionId?: string): void;
  setPluginStatus(agent: CommandAgent, text: string, options?: PluginStatusOptions): void;
  clearPluginStatus(agent: CommandAgent, ownerSessionId?: string): void;
  syncModelDisplay(agent: CommandAgent): void;
  isAgentRunning(): boolean;
  isAgentBusy(agent?: CommandAgent): boolean;
  getCurrentAgentSessionId(): string | undefined;
  getCurrentAgent(): CommandAgent | undefined;
  getCurrentSessionController(): CommandSessionController | undefined;
  renameCurrentAgentSession(title: string): void;
  listRunningAgents(): RunningAgentRecord[];
  clearIdleAgents(): ClearIdleAgentsResult;
  newAgentSession(): RunningAgentRecord;
  submitAgentSessionInput(id: string, text: string): Promise<SubmitResult>;
  forkCurrentAgent(): ForkAgentResult;
  switchAgentSession(id: string): RunningAgentRecord;
  refreshCurrentAgentSessionUi(): void;
  getRewindPreview(): RewindPreviewResult;
  applyRewind(id: string): RewindApplyResult;
  runExclusiveTask<T>(agent: CommandAgent, options: ExclusiveTaskOptions, task: () => Promise<T>): Promise<T>;
  compact(
    agent: CommandAgent,
    sessionController: CommandSessionController,
    ownerSessionId?: string,
    options?: CompactOptions,
  ): Promise<CompactResult>;
  recap(agent: CommandAgent, ownerSessionId?: string, options?: RecapOptions): Promise<RecapResult>;
  requestExit(): void | Promise<void>;
};
