import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { micaSession } from '@packages/mica-session/index.js';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import { MIGRATIONS, type Migration } from './migrations.js';
import { fileSignature, readEvolutionState, writeEvolutionState, type EvolutionFileState } from './state.js';

/**
 * 一轮清洗的结果。`pending` 是「这一轮没能处理完」的会话数：单轮有时间与数量上限，
 * 剩下的下一轮继续（迁移幂等，重复评估不会出事）。
 */
export type EvolutionRunResult = {
  outcome: 'ok' | 'busy';
  /** 目录里看到的会话文件数。 */
  scanned: number;
  /** 这一轮真正读过文件的会话数。 */
  evaluated: number;
  /** 改写过内容的会话数。 */
  migratedFiles: number;
  /** 补上的字段总数（例如补上的 occurredAt 条数）。 */
  migratedRecords: number;
  /** 正在跑轮次、拿不到 turn lease 而跳过的会话数。 */
  busyFiles: number;
  /** 解析不了的会话数（坏文件，签名不变就不再重试）。 */
  brokenFiles: number;
  /** 还等着下一轮处理的会话数。 */
  pending: number;
  elapsedMs: number;
  finishedAt: number;
};

export type EvolutionRunOptions = {
  /** `$MICA_HOME`；会话目录与插件数据都在它下面。 */
  home: string;
  migrations?: Migration[];
  /** 改动前把会话文件原样备份到 `plugin-data/evolution/backups/`。 */
  backup?: boolean;
  /** 单轮最多读多少个文件；默认 400。 */
  maxFiles?: number;
  signal?: AbortSignal;
  now?: () => number;
  /** 会话锁：拿不到就别碰这份文件（这一轮正在写它）。默认是 mica 的 turn lease。 */
  lockSession?: (sessionId: string) => { release(): void } | null;
  log?: (event: string, detail?: Record<string, unknown>) => void;
};

/**
 * 单轮最多占住事件循环多久就让出去一次。清洗是后台工作，不能把界面拖卡：
 * 一个几十 MB 的会话解析 + 写回是几十到几百毫秒，连续几十个就会明显掉帧。
 */
const SLICE_MS = 15;
/** 备份保留期：迁移改错时用来回滚，过期就删，不长期占磁盘。 */
const BACKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 与会话写盘同一规则（`mica-session/sessionStore.ts` 的 `serializeSession`）。 */
const PRETTY_SESSION_MAX_BYTES = 2 * 1024 * 1024;

export async function runEvolution(options: EvolutionRunOptions): Promise<EvolutionRunResult> {
  const now = options.now ?? Date.now;
  const migrations = options.migrations ?? MIGRATIONS;
  const startedAt = now();
  const dataDir = join(options.home, 'plugin-data', 'evolution');
  const statePath = join(dataDir, 'state.json');
  const releaseLock = acquireProcessLock(statePath);
  if (!releaseLock) return emptyResult('busy', now() - startedAt, now());
  try {
    const state = readEvolutionState(statePath);
    const sessions = listSessionFiles(join(options.home, 'sessions'));
    // 已删除的会话不必继续占着账本；顺带按时间清理过期备份。
    const present = new Set(sessions.map((session) => session.id));
    for (const id of Object.keys(state.files)) if (!present.has(id)) delete state.files[id];
    pruneBackups(join(dataDir, 'backups'), now());

    const limit = Math.max(1, options.maxFiles ?? 400);
    const lockSession = options.lockSession ?? micaSession.acquireTurnLease;
    let evaluated = 0;
    let migratedFiles = 0;
    let migratedRecords = 0;
    let busyFiles = 0;
    let brokenFiles = 0;
    let sliceStartedAt = now();
    /** 本轮确认过（已是最新形态或刚改写）的会话；剩下的都留给下一轮。 */
    const settled = new Set<string>();

    for (const session of sessions) {
      if (options.signal?.aborted) break;
      const known = state.files[session.id];
      if (isUpToDate(known, session.signature, migrations) || isKnownBroken(known, session.signature)) {
        settled.add(session.id);
        continue;
      }
      if (evaluated >= limit) break;
      evaluated += 1;
      const lease = lockSession(session.id);
      if (!lease) {
        busyFiles += 1;
        continue;
      }
      try {
        const outcome = migrateSessionFile(session, migrations, {
          backup: options.backup !== false,
          dataDir,
        });
        if (outcome.broken) {
          brokenFiles += 1;
          state.files[session.id] = { signature: session.signature, migrations: doneIds(migrations), broken: true };
        } else {
          migratedFiles += outcome.changed > 0 ? 1 : 0;
          migratedRecords += outcome.changed;
          state.files[session.id] = {
            signature: outcome.signature,
            migrations: doneIds(migrations),
          };
        }
        settled.add(session.id);
      } catch (error) {
        // 单个文件写失败不该让整轮死掉：不记签名，下一轮重试它。
        brokenFiles += 1;
        options.log?.('evolution:file-failed', {
          sessionId: session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        lease.release();
      }
      if (now() - sliceStartedAt > SLICE_MS) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        sliceStartedAt = now();
      }
    }

    const finishedAt = now();
    state.lastRunAt = new Date(finishedAt).toISOString();
    writeEvolutionState(statePath, state);
    const pending = sessions.length - settled.size;
    const result: EvolutionRunResult = {
      outcome: 'ok',
      scanned: sessions.length,
      evaluated,
      migratedFiles,
      migratedRecords,
      busyFiles,
      brokenFiles,
      pending,
      elapsedMs: finishedAt - startedAt,
      finishedAt,
    };
    options.log?.('evolution:run', { ...result });
    return result;
  } finally {
    releaseLock();
  }
}

type SessionFile = { id: string; path: string; signature: string };

function listSessionFiles(dir: string): SessionFile[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: SessionFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    if (entry.name === 'index.json' || entry.name === 'session-index.json') continue;
    const id = entry.name.slice(0, -'.json'.length);
    if (!id || id.includes('/') || id.includes('\\') || id.startsWith('.')) continue;
    const path = join(dir, entry.name);
    try {
      files.push({ id, path, signature: fileSignature(statSync(path)) });
    } catch {
      // 目录在列出来之后被删了：当作不存在。
    }
  }
  return files;
}

function migrateSessionFile(
  session: SessionFile,
  migrations: Migration[],
  options: { backup: boolean; dataDir: string },
): { changed: number; signature: string; broken: boolean } {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(session.path, 'utf-8'));
  } catch {
    return { changed: 0, signature: session.signature, broken: true };
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return { changed: 0, signature: session.signature, broken: true };
  }
  const root = document as Record<string, unknown>;
  let changed = 0;
  for (const migration of migrations) changed += migration.apply(root);
  if (changed === 0) return { changed: 0, signature: session.signature, broken: false };

  if (options.backup) backupSessionFile(session, options.dataDir);
  writeTextFileAtomic(session.path, serializeSessionFile(root));
  return { changed, signature: fileSignature(statSync(session.path)), broken: false };
}

/** 只保留首次迁移前的原样快照：同一会话后来被改写多少次，备份都是最早那份。 */
function backupSessionFile(session: SessionFile, dataDir: string): void {
  const dir = join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${session.id}.json`);
  if (existsSync(target)) return;
  copyFileSync(session.path, target);
}

function pruneBackups(dir: string, now: number): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    try {
      if (now - statSync(path).mtimeMs > BACKUP_TTL_MS) rmSync(path, { force: true });
    } catch {
      // 别人刚删掉：忽略。
    }
  }
}

function serializeSessionFile(document: Record<string, unknown>): string {
  const compact = JSON.stringify(document);
  const text = compact.length <= PRETTY_SESSION_MAX_BYTES ? JSON.stringify(document, null, 2) : compact;
  return `${text}\n`;
}

function isUpToDate(known: EvolutionFileState | undefined, signature: string, migrations: Migration[]): boolean {
  if (!known || known.signature !== signature) return false;
  return migrations.every((migration) => known.migrations.includes(migration.id));
}

/** 坏文件签名不变就别反复解析：这一份数据本身读不出来，等它被改写才有新机会。 */
function isKnownBroken(known: EvolutionFileState | undefined, signature: string): boolean {
  return Boolean(known?.broken) && known?.signature === signature;
}

function doneIds(migrations: Migration[]): string[] {
  return migrations.map((migration) => migration.id);
}

function emptyResult(outcome: 'busy', elapsedMs: number, finishedAt: number): EvolutionRunResult {
  return {
    outcome,
    scanned: 0,
    evaluated: 0,
    migratedFiles: 0,
    migratedRecords: 0,
    busyFiles: 0,
    brokenFiles: 0,
    pending: 0,
    elapsedMs,
    finishedAt,
  };
}
