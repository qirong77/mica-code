import type { AgentUsageRecord } from '@packages/mica-agent/index.js';
import type { MicaUiWorkingStatus } from '@packages/mica-ui/index.js';

export type CommandAgent = {
  readonly config: {
    provider: {
      id: string;
      name?: string;
      supportsEffort?: boolean;
      contextWindowSize: number;
    };
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

export type RewindFileChange = {
  path: string;
  action: 'restore' | 'delete';
};

export type RewindPreviewResult =
  | {
      ok: true;
      id: string;
      conversationLabel: string;
      createdAt: string;
      messageCountBefore: number;
      messageCountNow: number;
      fileStateAvailable: boolean;
      fileStateError?: string;
      files: RewindFileChange[];
    }
  | { ok: false; message: string };

export type RewindApplyResult = {
  id: string;
  conversationLabel: string;
  messageCount: number;
  fileStateAvailable: boolean;
  fileStateError?: string;
  files: RewindFileChange[];
};

export type PluginStatusOptions = {
  ownerSessionId?: string;
  level?: 'info' | 'warn' | 'error';
};

export type ExclusiveTaskOptions = PluginStatusOptions & {
  statusText: string;
};

export type CommandRuntimeServices = {
  clearUI(agent: CommandAgent, sessionController?: CommandSessionController): void;
  showMessage(text: string, ttl?: number, ownerSessionId?: string): void;
  setPluginStatus(agent: CommandAgent, text: string, options?: PluginStatusOptions): void;
  clearPluginStatus(agent: CommandAgent, ownerSessionId?: string): void;
  syncModelDisplay(agent: CommandAgent): void;
  isAgentRunning(): boolean;
  isAgentBusy(agent?: CommandAgent): boolean;
  getCurrentAgentSessionId(): string | undefined;
  getCurrentAgent(): CommandAgent | undefined;
  getCurrentSessionController(): CommandSessionController | undefined;
  listRunningAgents(): RunningAgentRecord[];
  clearIdleAgents(): ClearIdleAgentsResult;
  newAgentSession(): RunningAgentRecord;
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
  ): Promise<{
    beforeCount: number;
    afterCount: number;
    beforeTokenEstimate: number;
    afterTokenEstimate: number;
  }>;
};
