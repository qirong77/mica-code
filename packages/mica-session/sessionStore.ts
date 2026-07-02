import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import type { AgentUsageRecord } from '@packages/mica-agent/index.js';
import type { EffortOption } from '@packages/mica-config/index.js';

export type PersistedRuntimeSnapshot = {
  providerId: string;
  model: string;
  effort: EffortOption;
  messages: unknown[];
  conversationMessages: unknown[];
  usageHistory: AgentUsageRecord[];
  lastUsage: AgentUsageRecord | undefined;
};

export type PersistedSession = {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  snapshot: PersistedRuntimeSnapshot;
};

export type SessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
  cwd: string;
  providerId: string;
  model: string;
};

export type SessionStoreLike = {
  list(limit?: number): SessionSummary[];
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
      }));
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
  if (!session.snapshot.providerId || !session.snapshot.model || !session.snapshot.effort) return null;
  if (!Array.isArray(session.snapshot.messages)) return null;
  if (!Array.isArray(session.snapshot.conversationMessages)) return null;
  if (!Array.isArray(session.snapshot.usageHistory)) return null;
  return session as PersistedSession;
}
