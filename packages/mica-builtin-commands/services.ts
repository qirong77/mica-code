import type { AgentUsageRecord } from '@packages/mica-agent/index.js';

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
  reloadConfig(resetClient?: boolean): void;
  createSubAgent(options?: {
    systemPrompt?: string;
    [key: string]: unknown;
  }): {
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
};

export type RunningAgentRecord = {
  version: 2;
  id: string;
  pid: number;
  cwd: string;
  providerId: string;
  providerName: string;
  model: string;
  status: string;
  sessionId?: string;
  sessionTitle?: string;
  startedAt: string;
  updatedAt: string;
  ipc: {
    transport: 'unix';
    socketPath: string;
    protocol: 'mica-agent-rpc';
    version: 1;
  };
  capabilities: {
    attach: boolean;
    exclusiveControl: boolean;
    observe: boolean;
    remoteCommands: boolean;
    takeover: boolean;
  };
  control: {
    mode: 'local' | 'remote-controlled';
    controllerAgentId?: string;
    controllerPid?: number;
    controllerCwd?: string;
    attachedAt?: string;
  };
};

export type CommandRuntimeServices = {
  clearUI(agent: CommandAgent, sessionController?: CommandSessionController): void;
  showMessage(text: string, ttl?: number): void;
  syncModelDisplay(agent: CommandAgent): void;
  isAgentRunning(): boolean;
  listRunningAgents(): RunningAgentRecord[];
  attachAgent(agent: RunningAgentRecord): Promise<string>;
  detachAgent(): Promise<string>;
  compact(agent: CommandAgent, sessionController: CommandSessionController): Promise<{
    beforeCount: number;
    afterCount: number;
    beforeTokenEstimate: number;
    afterTokenEstimate: number;
  }>;
};
