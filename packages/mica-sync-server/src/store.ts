import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type MachineRecord = {
  id: string;
  name: string;
  hostname: string;
  platform: string;
  version: string;
  createdAt: string;
  lastSeen: string;
  activeSessionId: string | null;
  activeRunning: boolean;
};

export type SessionSummaryInfo = {
  id: string;
  title: string;
  createdAt?: string;
  updatedAt: string;
  cwd: string;
  providerId: string;
  model: string;
  effort?: string;
  role?: string;
  turnState: string;
  uncompleted: boolean;
};

export type StoredSession = {
  id: string;
  revision?: number;
  title: string;
  createdAt?: string;
  updatedAt: string;
  cwd: string;
  turnState: string;
  snapshot: {
    providerId?: string;
    model?: string;
    effort?: string;
    role?: string;
    conversationMessages?: unknown;
  };
  [key: string]: unknown;
};

const MACHINE_FILE = 'machines.json';

function readJsonFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function writeJsonFileAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

/** Lightweight JSON-file store for machines and session snapshots. */
export class SyncStore {
  private readonly machinesPath: string;
  private readonly sessionsDir: string;
  private readonly summaryCache = new Map<string, { mtimeMs: number; size: number; summary: SessionSummaryInfo }>();

  constructor(private readonly dataDir: string) {
    this.machinesPath = join(dataDir, MACHINE_FILE);
    this.sessionsDir = join(dataDir, 'sessions');
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  // ── machines ──

  listMachines(): MachineRecord[] {
    const records = readJsonFile<Record<string, MachineRecord>>(this.machinesPath) ?? {};
    return Object.values(records).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  getMachine(id: string): MachineRecord | null {
    return this.listMachines().find((machine) => machine.id === id) ?? null;
  }

  /**
   * Register a machine. Reuses the existing record when `id` matches, or when
   * the hostname matches an existing record (so a lost sync.json keeps the
   * same machine identity).
   */
  upsertMachine(input: {
    id?: string;
    name: string;
    hostname: string;
    platform: string;
    version: string;
  }): MachineRecord {
    const records = readJsonFile<Record<string, MachineRecord>>(this.machinesPath) ?? {};
    const now = new Date().toISOString();
    const existing =
      (input.id && records[input.id]) || Object.values(records).find((m) => m.hostname === input.hostname);
    const machine: MachineRecord = existing
      ? { ...existing, name: input.name || existing.name, lastSeen: now }
      : {
          id: input.id || randomUUID(),
          name: input.name || input.hostname || 'unnamed',
          hostname: input.hostname || '',
          platform: input.platform || '',
          version: input.version || '',
          createdAt: now,
          lastSeen: now,
          activeSessionId: null,
          activeRunning: false,
        };
    records[machine.id] = machine;
    writeJsonFileAtomic(this.machinesPath, records);
    return machine;
  }

  updateMachine(id: string, patch: Partial<MachineRecord>): MachineRecord | null {
    const records = readJsonFile<Record<string, MachineRecord>>(this.machinesPath) ?? {};
    const machine = records[id];
    if (!machine) return null;
    records[id] = { ...machine, ...patch };
    writeJsonFileAtomic(this.machinesPath, records);
    return records[id];
  }

  deleteMachine(id: string): void {
    const records = readJsonFile<Record<string, MachineRecord>>(this.machinesPath) ?? {};
    if (!records[id]) return;
    delete records[id];
    writeJsonFileAtomic(this.machinesPath, records);
    rmSync(join(this.sessionsDir, id), { recursive: true, force: true });
    this.summaryCache.clear();
  }

  // ── sessions ──

  private machineDir(machineId: string): string {
    return join(this.sessionsDir, machineId);
  }

  writeSession(machineId: string, session: StoredSession): boolean {
    if (!session?.id) return false;
    const dir = this.machineDir(machineId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${session.id}.json`);
    const current = readJsonFile<StoredSession>(path);
    if (current && !isNewerSession(session, current)) return false;
    writeJsonFileAtomic(path, session);
    this.summaryCache.delete(`${machineId}/${session.id}.json`);
    return true;
  }

  deleteSession(machineId: string, sessionId: string): boolean {
    const path = join(this.machineDir(machineId), `${sessionId}.json`);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    this.summaryCache.delete(`${machineId}/${sessionId}.json`);
    return true;
  }

  readSession(machineId: string, sessionId: string): StoredSession | null {
    const path = join(this.machineDir(machineId), `${sessionId}.json`);
    if (!existsSync(path)) return null;
    return readJsonFile<StoredSession>(path);
  }

  listSessionSummaries(machineId: string): SessionSummaryInfo[] {
    const dir = this.machineDir(machineId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        const path = join(dir, file);
        const stat = statSync(path);
        const cached = this.summaryCache.get(`${machineId}/${file}`);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.summary;
        const session = readJsonFile<StoredSession>(path);
        const summary = session ? toSummary(session) : null;
        if (summary) this.summaryCache.set(`${machineId}/${file}`, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
        return summary;
      })
      .filter((summary): summary is SessionSummaryInfo => Boolean(summary))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

function isNewerSession(next: StoredSession, current: StoredSession): boolean {
  if (typeof next.revision === 'number' || typeof current.revision === 'number') {
    return (next.revision ?? 0) > (current.revision ?? 0);
  }
  return next.updatedAt > current.updatedAt;
}

function toSummary(session: StoredSession): SessionSummaryInfo {
  return {
    id: session.id,
    title: session.title || 'Untitled session',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cwd: session.cwd,
    providerId: session.snapshot?.providerId ?? '',
    model: session.snapshot?.model ?? '',
    effort: session.snapshot?.effort,
    role: session.snapshot?.role,
    turnState: session.turnState,
    uncompleted: session.turnState !== 'completed',
  };
}
