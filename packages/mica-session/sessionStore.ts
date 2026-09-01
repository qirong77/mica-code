import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import type { AgentUsageRecord, SubagentUsageRecord } from '@packages/mica-agent/index.js';
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
  /** Model context window in tokens; informational for the web console's
   *  context usage display. Optional so older snapshots parse cleanly. */
  contextWindowSize?: number;
  messages: unknown[];
  conversationMessages: unknown[];
  usageHistory: AgentUsageRecord[];
  lastUsage: AgentUsageRecord | undefined;
  /** Subagent task usage appended by the Agent tool; optional for older snapshots. */
  subagentUsageHistory?: SubagentUsageRecord[];
};

export type PersistedSessionTurnState = 'running' | 'completed' | 'aborted' | 'error';

export type PersistedSession = {
  version: 1;
  revision?: number;
  id: string;
  title: string;
  titleSource?: 'derived' | 'auto' | 'manual';
  createdAt: string;
  updatedAt: string;
  cwd: string;
  turnState: PersistedSessionTurnState;
  snapshot: PersistedRuntimeSnapshot;
};

export type SessionSummary = {
  id: string;
  title: string;
  createdAt?: string;
  updatedAt: string;
  cwd: string;
  providerId: string;
  model: string;
  uncompleted: boolean;
  turnState?: PersistedSessionTurnState;
  effort?: EffortOption;
  role?: string;
};

export type SessionStoreLike = {
  list(limit?: number): SessionSummary[];
  listRecent(limit?: number): SessionSummary[];
  listAllForUsage?(): PersistedSession[];
  load(id: string): PersistedSession | null;
  save(session: PersistedSession): void;
  replaceValidated?(id: string, content: string): PersistedSession;
  delete(id: string): boolean;
};

export type SessionTurnLease = {
  sessionId: string;
  release(): void;
};

const MICA_HOME = resolveMicaHome();
export const SESSION_DIR = resolve(MICA_HOME, 'sessions');
const SESSION_INDEX_FILE = resolve(MICA_HOME, 'session-index.json');
const MALFORMED_LEASE_STALE_MS = 60_000;
const SUMMARY_HEAD_BYTES = 16 * 1024;

export class SessionStore implements SessionStoreLike {
  /** In-memory metadata summaries sorted by updatedAt descending. Lazily built. */
  private cachedIndex: SessionSummary[] | null = null;

  list(limit = 20): SessionSummary[] {
    return this.ensureIndex()
      .slice(0, limit)
      .map((session) => ({ ...session }));
  }

  listRecent(limit = 20): SessionSummary[] {
    return this.ensureIndex()
      .slice(0, limit)
      .map((session) => ({ ...session }));
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
    const safeId = sanitizeSessionId(session.id);
    if (!safeId || safeId !== session.id) throw new Error(`Invalid session id: ${session.id}`);
    const path = sessionPath(safeId);
    const tmpPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(session, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, path);
    try {
      this.updateIndexForSave(session);
    } catch {
      // best-effort metadata index; a rebuild reconciles it on the next list.
    }
  }

  replaceValidated(id: string, content: string): PersistedSession {
    const safeId = sanitizeSessionId(id);
    if (!safeId || safeId !== id.trim()) throw new Error('Invalid session id');

    const current = this.load(safeId);
    if (!current) throw new Error(`Session not found: ${safeId}`);
    if (current.turnState === 'running') throw new Error(`Cannot replace running session: ${safeId}`);

    let data: unknown;
    try {
      data = JSON.parse(content) as unknown;
    } catch (error) {
      throw new Error(`Invalid session JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const session = parsePersistedSession(data);
    if (!session) throw new Error('Invalid persisted session');
    if (session.id !== safeId) {
      throw new Error(`Session id mismatch: expected ${safeId}, received ${session.id}`);
    }
    if (session.turnState === 'running') throw new Error(`Cannot save running session: ${safeId}`);

    this.save(session);
    return session;
  }

  delete(id: string): boolean {
    const safeId = sanitizeSessionId(id);
    if (!safeId) return false;
    const path = sessionPath(safeId);
    if (!existsSync(path)) {
      // The session file is gone, so any lock for it is an orphan. Clear it so a
      // later continue/resume of the same id is never blocked by a stale lock.
      try {
        rmSync(turnLockPath(safeId), { force: true });
      } catch {
        // best-effort; a leftover lock is reconciled on acquire if it persists.
      }
      return false;
    }
    rmSync(path, { force: true });
    try {
      this.removeFromIndex(safeId);
    } catch {
      // best-effort metadata index; a rebuild reconciles it on the next list.
    }
    // Drop the turn-lock alongside the session so a removed id never leaves a
    // lock behind. The lease dir is not part of the session scan, so it leaks.
    try {
      rmSync(turnLockPath(safeId), { force: true });
    } catch {
      // best-effort; a leftover lock is reconciled on acquire if it persists.
    }
    return true;
  }

  /** Returns all summaries (sorted by updatedAt desc) without parsing session bodies. */
  private ensureIndex(): SessionSummary[] {
    if (this.cachedIndex) return this.cachedIndex;
    const fromDisk = this.readIndexFromDisk();
    if (fromDisk) {
      this.cachedIndex = fromDisk;
      return fromDisk;
    }
    this.cachedIndex = this.rebuildIndex();
    this.persistIndex();
    return this.cachedIndex;
  }

  private readIndexFromDisk(): SessionSummary[] | null {
    try {
      if (!existsSync(SESSION_INDEX_FILE)) return null;
      // A newer directory mtime means a session file was added/removed/renamed
      // somewhere else (e.g. sync daemon), so the index may be stale.
      if (statSync(SESSION_DIR).mtimeMs > statSync(SESSION_INDEX_FILE).mtimeMs) return null;
      const data = JSON.parse(readFileSync(SESSION_INDEX_FILE, 'utf-8')) as unknown;
      if (!data || typeof data !== 'object') return null;
      const sessions = (data as { sessions?: unknown }).sessions;
      if (!Array.isArray(sessions)) return null;
      const summaries = sessions.filter(isSessionSummary).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return summaries;
    } catch {
      return null;
    }
  }

  private rebuildIndex(): SessionSummary[] {
    ensureSessionDir();
    return readdirSync(SESSION_DIR)
      .filter((file) => file.endsWith('.json') && file !== 'index.json' && file !== 'session-index.json')
      .map((file) => this.readSummary(resolve(SESSION_DIR, file)))
      .filter((session): session is SessionSummary => Boolean(session))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Reads summary metadata from the head of a session file, falling back to a
   * full parse only when the head cannot yield a complete summary. */
  private readSummary(path: string): SessionSummary | null {
    const head = readFileHead(path, SUMMARY_HEAD_BYTES);
    if (head) {
      const summary = extractSummaryFromHead(head);
      if (summary) return summary;
    }
    const session = this.read(path);
    return session ? toSessionSummary(session) : null;
  }

  private persistIndex(): void {
    const content = JSON.stringify({ version: 1, sessions: this.cachedIndex ?? [] }, null, 2);
    const tmpPath = `${SESSION_INDEX_FILE}.${process.pid}.tmp`;
    mkdirSync(MICA_HOME, { recursive: true });
    writeFileSync(tmpPath, `${content}\n`, 'utf-8');
    renameSync(tmpPath, SESSION_INDEX_FILE);
  }

  private updateIndexForSave(session: PersistedSession): void {
    const summary = toSessionSummary(session);
    this.mutateIndex((index) => {
      const existing = index.findIndex((entry) => entry.id === summary.id);
      if (existing >= 0) index[existing] = summary;
      else index.push(summary);
      index.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    });
  }

  private removeFromIndex(id: string): void {
    this.mutateIndex((index) => {
      const existing = index.findIndex((entry) => entry.id === id);
      if (existing >= 0) index.splice(existing, 1);
    });
  }

  private mutateIndex(mutate: (index: SessionSummary[]) => void): void {
    const index = this.ensureIndex();
    mutate(index);
    this.persistIndex();
  }

  private read(path: string): PersistedSession | null {
    try {
      if (!existsSync(path)) return null;
      const data = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      return parsePersistedSession(data);
    } catch {
      return null;
    }
  }

  private readForUsage(path: string): PersistedSession | null {
    try {
      if (!existsSync(path)) return null;
      const data = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
      return parsePersistedSession(data) ?? (Array.isArray(data) ? parseLegacySessionForUsage(path, data) : null);
    } catch {
      return null;
    }
  }
}

export const micaSessionStore = {
  dir: SESSION_DIR,
  createStore: createSessionStore,
  createId: createSessionId,
  acquireTurnLease: acquireSessionTurnLease,
  SessionStore,
};

/** Prevents local and remote turns from replacing the same session snapshot. */
export function acquireSessionTurnLease(sessionId: string): SessionTurnLease | null {
  const safeId = sanitizeSessionId(sessionId);
  if (!safeId || safeId !== sessionId) return null;
  ensureSessionDir();
  const lockDir = resolve(SESSION_DIR, '.turn-locks');
  mkdirSync(lockDir, { recursive: true });
  const lockPath = turnLockPath(safeId);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), 'utf8');
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        sessionId: safeId,
        release() {
          if (released) return;
          released = true;
          try {
            const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { token?: unknown };
            if (owner.token === token) rmSync(lockPath, { force: true });
          } catch {
            // Never remove a lock unless its token proves that we own it.
          }
        },
      };
    } catch (error) {
      if (!isAlreadyExistsError(error) || attempt > 0 || !removeStaleTurnLease(lockPath)) return null;
    }
  }
  return null;
}

export function createSessionId(date = new Date()): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

function toSessionSummary(session: PersistedSession): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    cwd: session.cwd,
    providerId: session.snapshot.providerId,
    model: session.snapshot.model,
    uncompleted: session.turnState !== 'completed',
    turnState: session.turnState,
    effort: session.snapshot.effort,
    role: session.snapshot.role,
  };
}

function isSessionSummary(value: unknown): value is SessionSummary {
  if (!value || typeof value !== 'object') return false;
  const session = value as Record<string, unknown>;
  return (
    typeof session.id === 'string' &&
    typeof session.title === 'string' &&
    typeof session.cwd === 'string' &&
    typeof session.updatedAt === 'string' &&
    typeof session.providerId === 'string' &&
    typeof session.model === 'string' &&
    typeof session.uncompleted === 'boolean'
  );
}

function readFileHead(path: string, bytes: number): string | null {
  try {
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.allocUnsafe(bytes);
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.toString('utf-8', 0, length);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function extractSummaryFromHead(head: string): SessionSummary | null {
  const id = pickString(head, 'id');
  const title = pickString(head, 'title');
  const createdAt = pickString(head, 'createdAt');
  const updatedAt = pickString(head, 'updatedAt');
  const cwd = pickString(head, 'cwd');
  const turnState = pickString(head, 'turnState');
  const providerId = pickString(head, 'providerId');
  const model = pickString(head, 'model');
  const effort = pickString(head, 'effort');
  const role = pickString(head, 'role');
  if (!id || !title || !cwd || !updatedAt || !providerId || !model) return null;
  return {
    id,
    title,
    createdAt,
    updatedAt,
    cwd,
    providerId,
    model,
    uncompleted: turnState !== undefined && turnState !== 'completed',
    turnState: isPersistedSessionTurnState(turnState) ? turnState : 'completed',
    effort: isEffortOption(effort) ? effort : 'none',
    role: role ?? 'default',
  };
}

function pickString(text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
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

function turnLockPath(id: string): string {
  return resolve(SESSION_DIR, '.turn-locks', `${id}.lock`);
}

function sanitizeSessionId(id: string): string | null {
  const trimmed = id.trim();
  if (!trimmed || basename(trimmed) !== trimmed) return null;
  const safe = trimmed.replace(/\.json$/, '');
  return safe && /^[a-zA-Z0-9_.-]+$/.test(safe) ? safe : null;
}

function removeStaleTurnLease(lockPath: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
    rmSync(lockPath, { force: true });
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < MALFORMED_LEASE_STALE_MS) return false;
      rmSync(lockPath, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}

export function parsePersistedSession(value: unknown): PersistedSession | null {
  if (!value || typeof value !== 'object') return null;
  const session = value as Partial<PersistedSession>;
  if (session.version !== 1) return null;
  if (!isNonEmptyString(session.id) || sanitizeSessionId(session.id) !== session.id) return null;
  if (!isNonEmptyString(session.title)) return null;
  if (!isNonEmptyString(session.createdAt) || !isNonEmptyString(session.updatedAt) || !isNonEmptyString(session.cwd)) {
    return null;
  }
  if (!session.snapshot || typeof session.snapshot !== 'object') return null;
  if (!isNonEmptyString(session.snapshot.providerId) || !isNonEmptyString(session.snapshot.model)) return null;
  if (!Array.isArray(session.snapshot.messages)) return null;
  if (!Array.isArray(session.snapshot.conversationMessages)) return null;
  if (!Array.isArray(session.snapshot.usageHistory)) return null;
  if (
    session.snapshot.subagentUsageHistory !== undefined &&
    !Array.isArray(session.snapshot.subagentUsageHistory)
  ) {
    return null;
  }
  const turnState = isPersistedSessionTurnState(session.turnState) ? session.turnState : 'completed';
  let protocol = session.snapshot.protocol;
  if (!isProviderProtocol(protocol)) {
    const provider: ProviderProtocol | undefined = session.snapshot.usageHistory
      ?.map((record) => record?.provider)
      .find(isProviderProtocol);
    protocol = provider ?? 'openai_chat_completions';
  }
  if (!isEffortOption(session.snapshot.effort)) return null;
  const role = isNonEmptyString(session.snapshot.role) ? session.snapshot.role : 'default';
  return {
    ...session,
    turnState,
    snapshot: {
      ...session.snapshot,
      protocol,
      role,
    },
  } as PersistedSession;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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
