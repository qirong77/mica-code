import { randomUUID } from 'node:crypto';
import {
  closeSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveMicaHomePath } from '@packages/mica-config/brand.js';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The persisted task shape. Persistence only needs to identify a task and carry
 * its payload verbatim, so the runtime enums stay loose here and the owner of
 * the richer runtime record reads it back through `readStoredSubagentTasks<T>`.
 */
export type StoredSubagentTask = {
  id: string;
  description: string;
  prompt?: string;
  subagent_type: string;
  model: string;
  effort: string;
  max_turns?: number;
  context_mode?: string;
  context_files?: string[];
  write_mode?: string;
  owned_paths?: string[];
  status: string;
  interrupted?: boolean;
  parent_task_id?: string;
  pluginId?: string;
  provider_id?: string;
  protocol?: string;
  activity?: string;
  activities?: { id: string; summary: string; toolName?: string; startedAt: string }[];
  timeline?: { id: string; kind: string; text: string; toolName?: string; at: string }[];
  timeline_truncated?: boolean;
  execution_pid?: number;
  execution_pending?: boolean;
  restart_origin?: { task_id: string; token: string };
  started_at: string;
  finished_at?: string;
  result?: string;
  error?: string;
  usage?: {
    records: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
  };
};

export function isValidSubagentSessionId(id: string): boolean {
  return ID_PATTERN.test(id);
}
function legacyPath(id: string): string {
  return resolveMicaHomePath('subagent-tasks', `${id}.json`);
}
function taskDir(id: string): string {
  return resolveMicaHomePath('subagent-tasks', id);
}
function validTask(item: unknown): item is StoredSubagentTask {
  if (!item || typeof item !== 'object') return false;
  const task = item as Partial<StoredSubagentTask>;
  return (
    typeof task.id === 'string' &&
    ID_PATTERN.test(task.id) &&
    typeof task.description === 'string' &&
    typeof task.subagent_type === 'string' &&
    typeof task.model === 'string' &&
    typeof task.effort === 'string' &&
    typeof task.status === 'string' &&
    typeof task.started_at === 'string'
  );
}

/** Only ESRCH proves the recorded process no longer exists. PID reuse and permission
 * errors deliberately remain uncertain; neither is evidence that execution ended. */
export function subagentExecutionEnded(task: StoredSubagentTask): boolean {
  if (task.execution_pending === false) return true;
  const pid = task.execution_pid;
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

type RestartClaimOwner = { version: 1 | 2; pid: number; token: string };
export type SubagentRestartClaim = { readonly id: string; readonly parent: string; readonly owner: RestartClaimOwner };
type RestartHandoff = { version: 2; original_id: string; token: string; task: StoredSubagentTask };

const RESTART_CLAIM_ERROR = 'Subagent restart is already claimed or cannot be safely claimed.';
const RESTART_TOKEN_PATTERN = /^[0-9a-f-]{36}$/;

function restartMarker(parent: string, id: string, token: string, suffix: string): string {
  return join(parent, `${id}.${token}.${suffix}`);
}

/** Treat inaccessible markers as errors, not as evidence that they are absent. */
function restartMarkerExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function readRestartOwner(path: string): RestartClaimOwner {
  // The previous implementation used an empty directory. Its owner and whether it
  // started a task are unknowable, so it must remain a one-shot claim.
  if (!lstatSync(path).isFile()) throw new Error(RESTART_CLAIM_ERROR);
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error(RESTART_CLAIM_ERROR);
  const owner = value as Partial<RestartClaimOwner>;
  if (
    (owner.version !== 1 && owner.version !== 2) ||
    !Number.isSafeInteger(owner.pid) ||
    !owner.pid ||
    owner.pid <= 0 ||
    typeof owner.token !== 'string' ||
    !RESTART_TOKEN_PATTERN.test(owner.token)
  )
    throw new Error(RESTART_CLAIM_ERROR);
  return owner as RestartClaimOwner;
}

function restartOwnerExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // PID reuse and permission errors are intentionally treated as still alive.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Each claim is an immutable, fully written file published by an atomic hard link.
 * An abandoned or released claim points to a new generation named by its unique
 * token. Generations are never removed: concurrent recoverers cannot accidentally
 * remove a newer owner's claim after observing an older one.
 */
export function claimSubagentRestart(id: string): SubagentRestartClaim {
  if (!ID_PATTERN.test(id)) throw new Error('Invalid subagent task id.');
  const parent = resolveMicaHomePath('subagent-restart-claims');
  const owner: RestartClaimOwner = { version: 2, pid: process.pid, token: randomUUID() };
  const candidate = restartMarker(parent, id, owner.token, 'candidate');
  let candidateCreated = false;
  try {
    mkdirSync(parent, { recursive: true });
    const fd = openSync(candidate, 'wx', 0o600);
    candidateCreated = true;
    try {
      writeFileSync(fd, JSON.stringify(owner));
    } finally {
      closeSync(fd);
    }
    let path = join(parent, id);
    const visited = new Set<string>();
    for (;;) {
      try {
        linkSync(candidate, path);
        return { id, parent, owner };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const current = readRestartOwner(path);
      if (visited.has(current.token)) throw new Error(RESTART_CLAIM_ERROR);
      visited.add(current.token);
      // Version 1 could persist an unmarked replacement before committing. Even
      // a dead or released owner may therefore have left a separately restartable
      // task. Its relationship to this claim cannot be reconstructed safely.
      if (current.version === 1) throw new Error(RESTART_CLAIM_ERROR);
      if (restartMarkerExists(restartMarker(parent, id, current.token, 'started')))
        throw new Error(RESTART_CLAIM_ERROR);
      if (
        !restartMarkerExists(restartMarker(parent, id, current.token, 'released')) &&
        !restartOwnerExited(current.pid)
      ) {
        throw new Error(RESTART_CLAIM_ERROR);
      }
      // The owner might have committed and then exited between the first
      // marker check and the liveness probe. Once it is dead or released it
      // cannot commit later, so this second check closes that race.
      if (restartMarkerExists(restartMarker(parent, id, current.token, 'started')))
        throw new Error(RESTART_CLAIM_ERROR);
      path = join(parent, `${id}.${current.token}`);
    }
  } catch {
    throw new Error(RESTART_CLAIM_ERROR);
  } finally {
    if (candidateCreated)
      try {
        unlinkSync(candidate);
      } catch {
        /* A leftover candidate is never a claim. */
      }
  }
}

function writeRestartMarker(claim: SubagentRestartClaim, suffix: 'released'): void {
  const fd = openSync(restartMarker(claim.parent, claim.id, claim.owner.token, suffix), 'wx', 0o600);
  try {
    closeSync(fd);
  } catch {
    /* The empty marker was already created. */
  }
}

/** Publish the complete replacement and the irreversible commit in one link. */
export function commitSubagentRestart(claim: SubagentRestartClaim, task: StoredSubagentTask): void {
  if (
    claim.owner.version !== 2 ||
    claim.owner.pid !== process.pid ||
    !validTask(task) ||
    task.id === claim.id ||
    task.status !== 'running' ||
    task.execution_pid !== process.pid ||
    task.execution_pending !== true ||
    task.restart_origin?.task_id !== claim.id ||
    task.restart_origin.token !== claim.owner.token
  ) {
    throw new Error(RESTART_CLAIM_ERROR);
  }
  if (restartMarkerExists(restartMarker(claim.parent, claim.id, claim.owner.token, 'released')))
    throw new Error(RESTART_CLAIM_ERROR);
  const candidate = restartMarker(claim.parent, claim.id, claim.owner.token, 'handoff-candidate');
  let created = false;
  try {
    const fd = openSync(candidate, 'wx', 0o600);
    created = true;
    const handoff: RestartHandoff = { version: 2, original_id: claim.id, token: claim.owner.token, task };
    try {
      writeFileSync(fd, JSON.stringify(handoff));
    } finally {
      closeSync(fd);
    }
    // The marker becomes visible only after the entire record has been written.
    // If linkSync succeeds, no subsequent cleanup failure may undo the commit.
    linkSync(candidate, restartMarker(claim.parent, claim.id, claim.owner.token, 'started'));
  } finally {
    if (created)
      try {
        unlinkSync(candidate);
      } catch {
        /* A leftover candidate is never a commit. */
      }
  }
}

export function releaseSubagentRestart(claim: SubagentRestartClaim): void {
  if (restartMarkerExists(restartMarker(claim.parent, claim.id, claim.owner.token, 'started')))
    throw new Error(RESTART_CLAIM_ERROR);
  writeRestartMarker(claim, 'released');
}

function readRestartHandoff(parent: string, id: string, token: string): StoredSubagentTask | undefined {
  const path = restartMarker(parent, id, token, 'started');
  if (!restartMarkerExists(path)) return undefined;
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error('Invalid subagent restart handoff.');
  const handoff = value as Partial<RestartHandoff>;
  const task = handoff.task;
  if (
    handoff.version !== 2 ||
    handoff.original_id !== id ||
    handoff.token !== token ||
    !validTask(task) ||
    task.id === id ||
    task.status !== 'running' ||
    task.execution_pending !== true ||
    !Number.isSafeInteger(task.execution_pid) ||
    !task.execution_pid ||
    task.execution_pid <= 0 ||
    task.restart_origin?.task_id !== id ||
    task.restart_origin.token !== token
  ) {
    throw new Error('Invalid subagent restart handoff.');
  }
  return task;
}

/** A provisional snapshot is usable only after its own handoff was published. */
export function isCommittedSubagentRestart(task: StoredSubagentTask): boolean {
  const origin = task.restart_origin;
  if (!origin || !ID_PATTERN.test(origin.task_id) || !RESTART_TOKEN_PATTERN.test(origin.token)) return false;
  try {
    return (
      readRestartHandoff(resolveMicaHomePath('subagent-restart-claims'), origin.task_id, origin.token)?.id === task.id
    );
  } catch (error) {
    reportStorageError('reading restart handoff', error);
    return false;
  }
}

/** Follow immutable claim generations without ever reclaiming or modifying them. */
function findRestartHandoff(id: string): StoredSubagentTask | undefined {
  const parent = resolveMicaHomePath('subagent-restart-claims');
  let path = join(parent, id);
  const visited = new Set<string>();
  for (;;) {
    if (!restartMarkerExists(path)) return undefined;
    const owner = readRestartOwner(path);
    if (visited.has(owner.token)) throw new Error(RESTART_CLAIM_ERROR);
    visited.add(owner.token);
    const started = restartMarker(parent, id, owner.token, 'started');
    if (restartMarkerExists(started)) {
      // Old started markers contain no replacement record and cannot establish
      // which task, if any, ran. Keep their original claim permanently fenced.
      return owner.version === 2 ? readRestartHandoff(parent, id, owner.token) : undefined;
    }
    if (owner.version === 1) return undefined;
    path = join(parent, `${id}.${owner.token}`);
  }
}

function reportStorageError(action: string, error: unknown): void {
  if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') console.error(`[subagent state] ${action}:`, error);
}

/**
 * 磁盘上任务记录的轻量指纹：目录 + 迁移前那份单文件的 mtime/size。
 *
 * 常驻宿主每秒推一次任务快照，而 `readStoredSubagentTasks()` 要把每份记录（单条
 * result 上限 200k 字符）读出来并 JSON.parse。调用方先比这个指纹，没变就不重读。
 * 原子写会 rename 进目录，目录 mtime 因此一定会变。
 */
export function storedSubagentTasksStamp(id: string): string {
  if (!isValidSubagentSessionId(id)) return '';
  const parts: string[] = [];
  for (const target of [taskDir(id), legacyPath(id)]) {
    try {
      const info = statSync(target);
      parts.push(`${info.mtimeMs}:${info.size}`);
    } catch {
      parts.push('-');
    }
  }
  return parts.join('|');
}

export function readStoredSubagentTasks<T extends StoredSubagentTask = StoredSubagentTask>(id: string): T[] {
  if (!isValidSubagentSessionId(id)) return [];
  const records = new Map<string, StoredSubagentTask>();
  try {
    const legacy: unknown = JSON.parse(readFileSync(legacyPath(id), 'utf8'));
    if (Array.isArray(legacy)) for (const task of legacy) if (validTask(task)) records.set(task.id, task);
  } catch (error) {
    reportStorageError('reading legacy records', error);
  }
  try {
    for (const name of readdirSync(taskDir(id))) {
      if (!name.endsWith('.json') || !ID_PATTERN.test(name.slice(0, -5))) continue;
      try {
        const task: unknown = JSON.parse(readFileSync(resolveMicaHomePath('subagent-tasks', id, name), 'utf8'));
        if (validTask(task) && `${task.id}.json` === name) records.set(task.id, task);
      } catch (error) {
        reportStorageError(`reading task ${name}`, error);
      }
    }
  } catch (error) {
    reportStorageError('reading task directory', error);
  }
  // Snapshots can be emitted before commit. Ignore an abandoned replacement,
  // then recover committed replacements from the handoff even when their normal
  // snapshot was never saved. Repeating this also recovers chains of restarts.
  for (const [taskId, task] of records) {
    if (task.restart_origin !== undefined && !isCommittedSubagentRestart(task)) records.delete(taskId);
  }
  const pending = [...records.keys()];
  for (let index = 0; index < pending.length; index++) {
    try {
      const replacement = findRestartHandoff(pending[index]!);
      if (replacement && !records.has(replacement.id)) {
        records.set(replacement.id, replacement);
        pending.push(replacement.id);
      }
    } catch (error) {
      reportStorageError('recovering restart handoff', error);
    }
  }
  const restored = [...records.values()]
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .map((task) =>
      task.status === 'running' && subagentExecutionEnded(task)
        ? { ...task, status: 'failed', error: 'Application restarted before this task completed.', activities: [] }
        : { ...task, activities: [] },
    );
  // Identification is validated above; the remaining payload fields are opaque
  // to this module and reach the caller exactly as they were persisted.
  return restored as unknown as T[];
}

/** Each execution writes only its own record, so independent processes cannot replace each other's tasks. */
export function writeStoredSubagentTasks(id: string, tasks: readonly StoredSubagentTask[]): void {
  if (!isValidSubagentSessionId(id)) return;
  for (const task of tasks) {
    if (!ID_PATTERN.test(task.id)) continue;
    try {
      writeTextFileAtomic(resolveMicaHomePath('subagent-tasks', id, `${task.id}.json`), JSON.stringify(task));
    } catch (error) {
      console.error(`[subagent state] writing task ${task.id}:`, error);
    }
  }
}
