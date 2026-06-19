import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { AgentRuntime, AgentRuntimeStatus } from '../agent/AgentRuntime.js';

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
    attach: true;
    exclusiveControl: true;
    observe: true;
    remoteCommands: true;
    takeover: true;
  };
  control: {
    mode: 'local' | 'remote-controlled';
    controllerAgentId?: string;
    controllerPid?: number;
    controllerCwd?: string;
    attachedAt?: string;
  };
};

const AGENTS_DIR = resolve(homedir(), '.mica', 'agents');
const STALE_MS = 60_000;
const HEARTBEAT_MS = 10_000;

export class AgentRegistry {
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private status = 'idle';
  private readonly agentId = `${process.pid}-${Date.now()}`;
  private readonly startedAt = new Date().toISOString();
  private control: RunningAgentRecord['control'] = { mode: 'local' };

  constructor(private readonly agent: AgentRuntime) {}

  get id(): string {
    return this.agentId;
  }

  get socketPath(): string {
    return resolve(AGENTS_DIR, `${this.agentId}.sock`);
  }

  setControl(control: RunningAgentRecord['control']): void {
    this.control = control;
    this.write();
  }

  start(): void {
    ensureAgentsDir();
    this.write();
    this.heartbeat = setInterval(() => this.write(), HEARTBEAT_MS);
    this.heartbeat.unref?.();
    this.agent.events.on('status', this.onStatus);
    process.once('exit', this.cleanup);
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.agent.events.off('status', this.onStatus);
    process.off('exit', this.cleanup);
    this.cleanup();
  }

  list(): RunningAgentRecord[] {
    return listRunningAgents();
  }

  private readonly onStatus = (status: AgentRuntimeStatus) => {
    this.status = formatStatus(status);
    this.write();
  };

  private readonly cleanup = () => {
    rmSync(agentPath(process.pid), { force: true });
  };

  private write(): void {
    ensureAgentsDir();
    const { provider, model } = this.agent.config;
    const now = new Date().toISOString();
    const record: RunningAgentRecord = {
      version: 2,
      id: this.agentId,
      pid: process.pid,
      cwd: process.cwd(),
      providerId: provider.id,
      providerName: provider.name ?? provider.id,
      model,
      status: this.status,
      startedAt: this.startedAt,
      updatedAt: now,
      ipc: {
        transport: 'unix',
        socketPath: this.socketPath,
        protocol: 'mica-agent-rpc',
        version: 1,
      },
      capabilities: {
        attach: true,
        exclusiveControl: true,
        observe: true,
        remoteCommands: true,
        takeover: true,
      },
      control: this.control,
    };
    writeFileSync(agentPath(process.pid), `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
  }
}

export function listRunningAgents(): RunningAgentRecord[] {
  ensureAgentsDir();
  const now = Date.now();
  return readdirSync(AGENTS_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => resolve(AGENTS_DIR, file))
    .map((path) => ({ path, record: readAgentRecord(path) }))
    .filter((entry): entry is { path: string; record: RunningAgentRecord } => {
      if (entry.record) return true;
      rmSync(entry.path, { force: true });
      return false;
    })
    .filter(({ path, record }) => {
      const alive = isProcessAlive(record.pid) && now - Date.parse(record.updatedAt) <= STALE_MS;
      if (!alive) rmSync(path, { force: true });
      return alive;
    })
    .sort((a, b) => b.record.updatedAt.localeCompare(a.record.updatedAt))
    .map(({ record }) => record);
}

function readAgentRecord(path: string): RunningAgentRecord | null {
  try {
    if (!existsSync(path)) return null;
    const value = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    return parseAgentRecord(value);
  } catch {
    return null;
  }
}

function parseAgentRecord(value: unknown): RunningAgentRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<RunningAgentRecord>;
  if (record.version !== 2) return null;
  if (!record.id || !record.cwd || !record.providerId || !record.model || !record.status || !record.startedAt || !record.updatedAt) {
    return null;
  }
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) return null;
  if (!record.ipc || !record.capabilities || !record.control) return null;
  return record as RunningAgentRecord;
}

function formatStatus(status: AgentRuntimeStatus): string {
  if (status.type === 'calling_tool') {
    const tools = status.toolNames?.join(', ');
    return tools ? `calling_tool:${tools}` : 'calling_tool';
  }
  if (status.type === 'completed') return 'idle';
  if (status.type === 'error') return `error:${status.message}`;
  return status.type;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureAgentsDir() {
  mkdirSync(AGENTS_DIR, { recursive: true });
}

function agentPath(pid: number): string {
  return resolve(AGENTS_DIR, `${pid}.json`);
}
