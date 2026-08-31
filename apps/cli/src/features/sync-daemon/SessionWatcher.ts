import { readFileSync, readdirSync, statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR_NAME } from '@packages/mica-config/brand.js';
import type { PersistedSession } from '@packages/mica-session/index.js';

export type SessionChangeHandler = (session: PersistedSession | null, sessionId: string) => void;

const DEBOUNCE_MS = 250;
const RESCAN_INTERVAL_MS = 30_000;

type FileStamp = { mtimeMs: number; size: number };

/**
 * Watches the local session directory and reports session snapshots to a
 * callback. fs.watch alone is unreliable (macOS rename events can carry a null
 * filename), so a periodic rescan compares mtime/size as a backstop. A `null`
 * session means the file was removed.
 */
export class SessionWatcher {
  private watcher: ReturnType<typeof watch> | null = null;
  private rescanTimer: ReturnType<typeof setInterval> | null = null;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly lastSeen = new Map<string, FileStamp>();
  private stopped = false;

  constructor(
    private readonly dir: string,
    private readonly onChange: SessionChangeHandler,
  ) {}

  start(): void {
    this.scanAll();
    try {
      this.watcher = watch(this.dir, (_event, filename) => {
        if (this.stopped) return;
        if (typeof filename !== 'string') {
          // Directory-level event without a filename: rescan everything.
          this.scanAll();
          return;
        }
        if (!filename.endsWith('.json')) return;
        this.schedule(filename.replace(/\.json$/, ''));
      });
    } catch (error) {
      console.error(`[mica-sync] session watch unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.rescanTimer = setInterval(() => {
      if (!this.stopped) this.scanAll();
    }, RESCAN_INTERVAL_MS);
    this.rescanTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = null;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  private scanAll(): void {
    let files: string[] = [];
    try {
      files = readdirSync(this.dir);
    } catch {
      return;
    }
    const seen = new Set<string>();
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const sessionId = file.replace(/\.json$/, '');
      seen.add(sessionId);
      const stamp = this.stampOf(join(this.dir, file));
      const previous = this.lastSeen.get(sessionId);
      if (previous && stamp && previous.mtimeMs === stamp.mtimeMs && previous.size === stamp.size) continue;
      if (stamp) this.lastSeen.set(sessionId, stamp);
      const session = stamp ? readSessionFile(join(this.dir, file)) : null;
      if (session) this.onChange(session, session.id);
    }
    for (const sessionId of this.lastSeen.keys()) {
      if (!seen.has(sessionId)) {
        this.lastSeen.delete(sessionId);
        this.onChange(null, sessionId);
      }
    }
  }

  private stampOf(path: string): FileStamp | null {
    try {
      const stat = statSync(path);
      if (!stat.isFile()) return null;
      return { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return null;
    }
  }

  private schedule(sessionId: string): void {
    const existing = this.pending.get(sessionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.pending.delete(sessionId);
      if (this.stopped) return;
      const path = join(this.dir, `${sessionId}.json`);
      const stamp = this.stampOf(path);
      const previous = this.lastSeen.get(sessionId);
      if (stamp && previous && previous.mtimeMs === stamp.mtimeMs && previous.size === stamp.size) return;
      if (stamp) this.lastSeen.set(sessionId, stamp);
      const session = stamp ? readSessionFile(path) : null;
      if (session) {
        this.onChange(session, session.id);
      } else {
        this.lastSeen.delete(sessionId);
        this.onChange(null, sessionId);
      }
    }, DEBOUNCE_MS);
    this.pending.set(sessionId, timer);
  }
}

function readSessionFile(path: string): PersistedSession | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as PersistedSession;
    if (!parsed?.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function sessionDir(): string {
  const micaHome = process.env.MICA_HOME ? resolveHome(process.env.MICA_HOME) : join(homedir(), CONFIG_DIR_NAME);
  return join(micaHome, 'sessions');
}

function resolveHome(value: string): string {
  return value === '~' ? join(homedir(), CONFIG_DIR_NAME) : value;
}
