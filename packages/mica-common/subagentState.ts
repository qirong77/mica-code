import { randomUUID } from 'node:crypto';
import { closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveMicaHomePath } from '@packages/mica-config/brand.js';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import type { SubagentTaskRecord } from '../../apps/cli/src/agents/SubagentTaskManager.js';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export function isValidSubagentSessionId(id: string): boolean { return ID_PATTERN.test(id); }
function legacyPath(id: string): string { return resolveMicaHomePath('subagent-tasks', `${id}.json`); }
function taskDir(id: string): string { return resolveMicaHomePath('subagent-tasks', id); }
function validTask(item: unknown): item is SubagentTaskRecord {
  if (!item || typeof item !== 'object') return false;
  const task = item as Partial<SubagentTaskRecord>;
  return typeof task.id === 'string' && ID_PATTERN.test(task.id) && typeof task.description === 'string' && typeof task.subagent_type === 'string' && typeof task.model === 'string' && typeof task.effort === 'string' && typeof task.status === 'string' && typeof task.started_at === 'string';
}

/** Only ESRCH proves the recorded process no longer exists. PID reuse and permission
 * errors deliberately remain uncertain; neither is evidence that execution ended. */
export function subagentExecutionEnded(task: SubagentTaskRecord): boolean {
  if (task.execution_pending === false) return true;
  const pid = task.execution_pid;
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0) return false;
  try { process.kill(pid, 0); return false; } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

type RestartClaimOwner = { version: 1; pid: number; token: string };
export type SubagentRestartClaim = { readonly id: string; readonly parent: string; readonly owner: RestartClaimOwner };

const RESTART_CLAIM_ERROR = 'Subagent restart is already claimed or cannot be safely claimed.';
const RESTART_TOKEN_PATTERN = /^[0-9a-f-]{36}$/;

function restartMarker(parent: string, id: string, token: string, suffix: string): string {
  return join(parent, `${id}.${token}.${suffix}`);
}

/** Treat inaccessible markers as errors, not as evidence that they are absent. */
function restartMarkerExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
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
  if (owner.version !== 1 || !Number.isSafeInteger(owner.pid) || !owner.pid || owner.pid <= 0 ||
      typeof owner.token !== 'string' || !RESTART_TOKEN_PATTERN.test(owner.token)) throw new Error(RESTART_CLAIM_ERROR);
  return owner as RestartClaimOwner;
}

function restartOwnerExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; } catch (error) {
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
  const owner: RestartClaimOwner = { version: 1, pid: process.pid, token: randomUUID() };
  const candidate = restartMarker(parent, id, owner.token, 'candidate');
  let candidateCreated = false;
  try {
    mkdirSync(parent, { recursive: true });
    const fd = openSync(candidate, 'wx', 0o600);
    candidateCreated = true;
    try { writeFileSync(fd, JSON.stringify(owner)); } finally { closeSync(fd); }
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
      if (restartMarkerExists(restartMarker(parent, id, current.token, 'started'))) throw new Error(RESTART_CLAIM_ERROR);
      if (!restartMarkerExists(restartMarker(parent, id, current.token, 'released')) && !restartOwnerExited(current.pid)) {
        throw new Error(RESTART_CLAIM_ERROR);
      }
      path = join(parent, `${id}.${current.token}`);
    }
  } catch {
    throw new Error(RESTART_CLAIM_ERROR);
  } finally {
    if (candidateCreated) try { unlinkSync(candidate); } catch { /* A leftover candidate is never a claim. */ }
  }
}

function writeRestartMarker(claim: SubagentRestartClaim, suffix: 'started' | 'released'): void {
  const fd = openSync(restartMarker(claim.parent, claim.id, claim.owner.token, suffix), 'wx', 0o600);
  try { closeSync(fd); } catch { /* The empty marker was already created. */ }
}

/** Commit only after the replacement was scheduled and before it can execute. */
export function commitSubagentRestart(claim: SubagentRestartClaim): void {
  if (restartMarkerExists(restartMarker(claim.parent, claim.id, claim.owner.token, 'released'))) throw new Error(RESTART_CLAIM_ERROR);
  writeRestartMarker(claim, 'started');
}

export function releaseSubagentRestart(claim: SubagentRestartClaim): void {
  if (restartMarkerExists(restartMarker(claim.parent, claim.id, claim.owner.token, 'started'))) throw new Error(RESTART_CLAIM_ERROR);
  writeRestartMarker(claim, 'released');
}

function reportStorageError(action: string, error: unknown): void {
  if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') console.error(`[subagent state] ${action}:`, error);
}

export function readStoredSubagentTasks(id: string): SubagentTaskRecord[] {
  if (!isValidSubagentSessionId(id)) return [];
  const records = new Map<string, SubagentTaskRecord>();
  try {
    const legacy: unknown = JSON.parse(readFileSync(legacyPath(id), 'utf8'));
    if (Array.isArray(legacy)) for (const task of legacy) if (validTask(task)) records.set(task.id, task);
  } catch (error) { reportStorageError('reading legacy records', error); }
  try {
    for (const name of readdirSync(taskDir(id))) {
      if (!name.endsWith('.json') || !ID_PATTERN.test(name.slice(0, -5))) continue;
      try {
        const task: unknown = JSON.parse(readFileSync(resolveMicaHomePath('subagent-tasks', id, name), 'utf8'));
        if (validTask(task) && `${task.id}.json` === name) records.set(task.id, task);
      } catch (error) { reportStorageError(`reading task ${name}`, error); }
    }
  } catch (error) { reportStorageError('reading task directory', error); }
  return [...records.values()].sort((a, b) => b.started_at.localeCompare(a.started_at)).map((task) => task.status === 'running' && subagentExecutionEnded(task)
    ? { ...task, status: 'failed' as const, error: 'Application restarted before this task completed.', activities: [] }
    : { ...task, activities: [] });
}

/** Each execution writes only its own record, so independent processes cannot replace each other's tasks. */
export function writeStoredSubagentTasks(id: string, tasks: SubagentTaskRecord[]): void {
  if (!isValidSubagentSessionId(id)) return;
  for (const task of tasks) {
    if (!ID_PATTERN.test(task.id)) continue;
    try { writeTextFileAtomic(resolveMicaHomePath('subagent-tasks', id, `${task.id}.json`), JSON.stringify(task)); } catch (error) { console.error(`[subagent state] writing task ${task.id}:`, error); }
  }
}
