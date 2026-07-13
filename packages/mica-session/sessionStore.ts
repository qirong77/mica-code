import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import type { AgentUsageRecord } from '@packages/mica-agent/index.js';
import {
  isEffortOption,
  isProviderProtocol,
  type EffortOption,
  type ProviderProtocol,
} from '@packages/mica-config/index.js';

export type PersistedRuntimeSnapshot = {
  providerId: string;
  protocol: ProviderProtocol;
  model: string;
  effort: EffortOption;
  role: string;
  messages: unknown[];
  conversationMessages: unknown[];
  usageHistory: AgentUsageRecord[];
  lastUsage: AgentUsageRecord | undefined;
};

export type PersistedSessionTurnState = 'running' | 'completed' | 'aborted' | 'error';

export type PersistedSession = {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  turnState: PersistedSessionTurnState;
  snapshot: PersistedRuntimeSnapshot;
};

export type SessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
  cwd: string;
  providerId: string;
  model: string;
  uncompleted: boolean;
};

export type SessionStoreLike = {
  list(limit?: number): SessionSummary[];
  listAllForUsage?(): PersistedSession[];
  load(id: string): PersistedSession | null;
  save(session: PersistedSession): void;
};

export const SESSION_DIR = resolve(homedir(), '.mica', 'sessions');

export class SessionStore implements SessionStoreLike {
  list(limit = 20): SessionSummary[] {
    ensureSessionDir();
    const cwd = process.cwd();
    return readdirSync(SESSION_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => this.read(resolve(SESSION_DIR, file)))
      .filter((session): session is PersistedSession => Boolean(session))
      .sort((a, b) => {
        const aMatch = a.cwd === cwd ? 0 : 1;
        const bMatch = b.cwd === cwd ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
        return b.updatedAt.localeCompare(a.updatedAt);
      })
      .slice(0, limit)
      .map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        cwd: session.cwd,
        providerId: session.snapshot.providerId,
        model: session.snapshot.model,
        uncompleted: session.turnState !== 'completed',
      }));
  }

  /** Reads current snapshots plus the legacy message-array format used by older Mica builds. */
  listAllForUsage(): PersistedSession[] {
    ensureSessionDir();
    return readdirSync(SESSION_DIR)
      .filter((file) => file.endsWith('.json') && file !== 'index.json' && file !== 'session-index.json')
      .map((file) => this.readForUsage(resolve(SESSION_DIR, file)))
      .filter((session): session is PersistedSession => Boolean(session));
  }

  load(id: string): PersistedSession | null {
    const safeId = sanitizeSessionId(id);
    if (!safeId) return null;
    return this.read(sessionPath(safeId));
  }

  save(session: PersistedSession): void {
    ensureSessionDir();
    const path = sessionPath(session.id);
    const tmpPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(session, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, path);
  }

  private read(path: string): PersistedSession | null {
    try {
      if (!existsSync(path)) return null;
      const data = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      return parseSession(data);
    } catch {
      return null;
    }
  }

  private readForUsage(path: string): PersistedSession | null {
    try {
      if (!existsSync(path)) return null;
      const data = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      return parseSession(data) ?? (Array.isArray(data) ? parseLegacySessionForUsage(path, data) : null);
    } catch {
      return null;
    }
  }
}

export const micaSessionStore = {
  dir: SESSION_DIR,
  createStore: createSessionStore,
  createId: createSessionId,
  SessionStore,
};

export function createSessionId(date = new Date()): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

function createSessionStore(): SessionStore {
  return new SessionStore();
}

function ensureSessionDir() {
  mkdirSync(SESSION_DIR, { recursive: true });
}

function sessionPath(id: string): string {
  return resolve(SESSION_DIR, `${id}.json`);
}

function sanitizeSessionId(id: string): string | null {
  const safe = basename(id.trim());
  return /^[a-zA-Z0-9_.-]+$/.test(safe) ? safe.replace(/\.json$/, '') : null;
}

function parseSession(value: unknown): PersistedSession | null {
  if (!value || typeof value !== 'object') return null;
  const session = value as Partial<PersistedSession>;
  if (session.version !== 1) return null;
  if (!session.id || !session.title || !session.createdAt || !session.updatedAt || !session.cwd) return null;
  if (!session.snapshot || typeof session.snapshot !== 'object') return null;
  if (!session.snapshot.providerId || !session.snapshot.model) return null;
  if (!isPersistedSessionTurnState(session.turnState)) session.turnState = 'completed';
  if (!isProviderProtocol(session.snapshot.protocol)) {
    const provider: ProviderProtocol | undefined = session.snapshot.usageHistory
      ?.map((record) => record?.provider)
      .find(isProviderProtocol);
    session.snapshot.protocol = provider ?? 'openai_chat_completions';
  }
  if (!isEffortOption(session.snapshot.effort)) return null;
  if (typeof session.snapshot.role !== 'string' || !session.snapshot.role.trim()) {
    session.snapshot.role = 'default';
  }
  if (!Array.isArray(session.snapshot.messages)) return null;
  if (!Array.isArray(session.snapshot.conversationMessages)) return null;
  if (!Array.isArray(session.snapshot.usageHistory)) return null;
  return session as PersistedSession;
}

function parseLegacySessionForUsage(path: string, messages: unknown[]): PersistedSession | null {
  const usageHistory: AgentUsageRecord[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const raw = (message as { usage?: unknown }).usage;
    if (!raw || typeof raw !== 'object') continue;
    const usage = raw as Record<string, unknown>;
    const uncached = finiteNumber(usage.input_tokens);
    const cacheRead = finiteNumber(usage.cache_read_input_tokens);
    const cacheWrite = finiteNumber(usage.cache_creation_input_tokens);
    const output = finiteNumber(usage.output_tokens);
    if (uncached + cacheRead + cacheWrite + output === 0) continue;
    const input = uncached + cacheRead + cacheWrite;
    usageHistory.push({
      provider: 'openai_chat_completions',
      turnId: usageHistory.length + 1,
      requestIndex: 0,
      messageCount: messages.length,
      inputTokens: input,
      cachedInputTokens: cacheRead,
      outputTokens: output,
      totalTokens: input + output,
      paidTokenRate: input > 0 ? (uncached + cacheWrite) / input : 1,
    });
  }
  if (usageHistory.length === 0) return null;
  const id = basename(path, '.json');
  const updatedAt = statSync(path).mtime.toISOString();
  return {
    version: 1,
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    cwd: '',
    turnState: 'completed',
    snapshot: {
      providerId: 'legacy',
      protocol: 'openai_chat_completions',
      model: 'legacy',
      effort: 'none',
      role: 'default',
      messages: [],
      conversationMessages: [],
      usageHistory,
      lastUsage: usageHistory.at(-1),
    },
  };
}

function isPersistedSessionTurnState(value: unknown): value is PersistedSessionTurnState {
  return value === 'running' || value === 'completed' || value === 'aborted' || value === 'error';
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}
