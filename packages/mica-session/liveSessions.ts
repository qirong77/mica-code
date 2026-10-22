import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { SESSION_DIR } from './sessionStore.js';

/**
 * A turn lease (`sessions/.turn-locks/<id>.lock`) is the only cross-process
 * record of "some Mica process is executing a turn for this session right now".
 * The lease file is written before the turn runs and removed after it, so the
 * holder pid is exactly the instance that may be touching the workspace.
 *
 * Idle instances hold no lease, which is fine for the purpose of this listing:
 * an idle Mica cannot have changed a file.
 */
export type SessionTurnLock = {
  sessionId: string;
  /** Holder process id (the mica process, not the desktop shell). */
  pid: number;
  /** When the holder acquired the lease = when the turn started (ISO). */
  startedAt: string;
  /** False when the holder pid is gone: a crashed turn left the lease behind. */
  alive: boolean;
  lockPath: string;
  sessionPath: string;
  /** Session metadata read from the file head; the snapshot is never parsed. */
  title?: string;
  cwd?: string;
  updatedAt?: string;
  turnState?: string;
  model?: string;
};

export type ListSessionTurnLocksOptions = {
  sessionDir?: string;
  /** pid liveness probe; defaults to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** Reads only the head of a session file; defaults to the first 4 KiB. */
  readHead?: (path: string) => string;
};

const HEAD_BYTES = 4096;
const LOCK_FILE = /^([A-Za-z0-9_.-]+)\.lock$/;

/** Same rule as the orphan-lease reclaimer: only ESRCH means "process gone". */
export function isProcessAlive(pid: number): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

export function listSessionTurnLocks(options: ListSessionTurnLocksOptions = {}): SessionTurnLock[] {
  const sessionDir = options.sessionDir ?? SESSION_DIR;
  const isAlive = options.isAlive ?? isProcessAlive;
  const readHead = options.readHead ?? readFileHead;
  const lockDir = resolve(sessionDir, '.turn-locks');

  let entries: string[];
  try {
    entries = readdirSync(lockDir);
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const locks: SessionTurnLock[] = [];
  for (const entry of entries) {
    const match = LOCK_FILE.exec(entry);
    if (!match) continue;
    const sessionId = match[1]!;
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);

    const lockPath = resolve(lockDir, entry);
    const owner = readLockOwner(lockPath);
    if (!owner) continue;

    const sessionPath = resolve(sessionDir, `${sessionId}.json`);
    const head = safeReadHead(readHead, sessionPath);
    locks.push({
      sessionId,
      pid: owner.pid,
      startedAt: owner.createdAt ?? safeMtimeIso(lockPath) ?? '',
      alive: isAlive(owner.pid),
      lockPath,
      sessionPath,
      title: readHeadField(head, 'title'),
      cwd: readHeadField(head, 'cwd'),
      updatedAt: readHeadField(head, 'updatedAt'),
      turnState: readHeadField(head, 'turnState'),
      model: readHeadField(head, 'model'),
    });
  }
  return locks.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function readLockOwner(lockPath: string): { pid: number; createdAt?: string } | null {
  try {
    const raw = readFileHead(lockPath, 1024);
    const parsed = JSON.parse(raw) as { pid?: unknown; createdAt?: unknown };
    const pid = parsed?.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    return { pid, createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined };
  } catch {
    // A lock mid-write (or a torn file) is skipped rather than guessed at.
    return null;
  }
}

function safeReadHead(readHead: (path: string) => string, path: string): string {
  try {
    return readHead(path);
  } catch {
    return '';
  }
}

function safeMtimeIso(path: string): string | undefined {
  try {
    return new Date(statSync(path).mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}

export function readFileHead(path: string, bytes = HEAD_BYTES): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore: closing a read handle is best-effort
      }
    }
  }
}

/**
 * Session files are written with the top-level keys before `snapshot`, so the
 * head is enough to describe a session without parsing a file that may be tens
 * of megabytes (images, full tool history).
 */
function readHeadField(head: string, key: string): string | undefined {
  if (!head) return undefined;
  const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const match = pattern.exec(head);
  if (!match) return undefined;
  const raw = match[1]!;
  if (!raw.includes('\\')) return raw;
  try {
    const parsed = JSON.parse(`"${raw}"`) as unknown;
    return typeof parsed === 'string' ? parsed : raw;
  } catch {
    return raw;
  }
}
