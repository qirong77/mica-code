import { spawnSync, type ChildProcess } from 'child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import crypto from 'crypto';
import { tmpdir } from 'os';
import path from 'path';
import { formatSize } from './utils/outputLimits.js';

export const MAX_BACKGROUND_OUTPUT_BYTES = 64 * 1024 * 1024;
const BACKGROUND_OUTPUT_WATCH_INTERVAL_MS = 5_000;
const TASK_ID_PATTERN = /^[a-f0-9]{12}$/;
const BACKGROUND_TASK_OWNER_ID = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
let backgroundTaskMonitor: NodeJS.Timeout | null = null;
let backgroundTaskExitCleanupRegistered = false;

export type BackgroundTaskStatus = 'starting' | 'running' | 'finished' | 'killed' | 'failed' | 'unknown_exited';

export type BackgroundTaskMeta = {
  id: string;
  command: string;
  cwd: string;
  shell: string;
  pid?: number;
  output_path: string;
  status: BackgroundTaskStatus;
  started_at: string;
  finished_at?: string;
  exit_code?: number | null;
  signal?: string | null;
  output_limit_bytes: number;
  owner_pid?: number;
  owner_id?: string;
  agent_owner_id?: string;
  error?: string;
};

export type OutputRange = {
  content: string;
  size: number;
  start: number;
  end: number;
};

export function taskId(): string {
  return crypto.randomBytes(6).toString('hex');
}

export function getBackgroundTaskDir(): string {
  return path.join(tmpdir(), 'mica-tasks', BACKGROUND_TASK_OWNER_ID);
}

export function getTaskOutputPath(id: string): string {
  assertSafeTaskId(id);
  return path.join(getBackgroundTaskDir(), `${id}.out`);
}

export function getTaskMetaPath(id: string): string {
  assertSafeTaskId(id);
  return path.join(getBackgroundTaskDir(), `${id}.json`);
}

export function assertSafeTaskId(id: string): void {
  if (!TASK_ID_PATTERN.test(id)) {
    throw new Error(`无效 task_id: ${id}`);
  }
}

function ensureBackgroundTaskDir(): void {
  mkdirSync(getBackgroundTaskDir(), { recursive: true });
}

function writeTaskMeta(meta: BackgroundTaskMeta): void {
  ensureBackgroundTaskDir();
  const filePath = getTaskMetaPath(meta.id);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, filePath);
}

export function backgroundHeader({
  id,
  command,
  cwd,
  shell,
  pid,
  outputLimit,
}: {
  id: string;
  command: string;
  cwd: string;
  shell: string;
  pid: number | undefined;
  outputLimit: number;
}): string {
  return [
    '[mica background task]',
    `id: ${id}`,
    `pid: ${pid ?? 'unknown'}`,
    `cwd: ${cwd}`,
    `shell: ${shell}`,
    `command: ${JSON.stringify(command)}`,
    `started_at: ${new Date().toISOString()}`,
    `output_limit: ${formatSize(outputLimit)}`,
    '',
  ].join('\n');
}

export function createBackgroundTaskMeta(params: {
  id: string;
  command: string;
  cwd: string;
  shell: string;
  outputPath: string;
  outputLimit: number;
  agentOwnerId?: string;
}): BackgroundTaskMeta {
  const meta: BackgroundTaskMeta = {
    id: params.id,
    command: params.command,
    cwd: params.cwd,
    shell: params.shell,
    output_path: params.outputPath,
    status: 'starting',
    started_at: new Date().toISOString(),
    output_limit_bytes: params.outputLimit,
    owner_pid: process.pid,
    owner_id: BACKGROUND_TASK_OWNER_ID,
    ...(params.agentOwnerId ? { agent_owner_id: params.agentOwnerId } : {}),
  };
  writeTaskMeta(meta);
  return meta;
}

export function markBackgroundTaskRunning(id: string, pid: number | undefined): void {
  const meta = loadBackgroundTask(id);
  if (!meta) return;
  writeTaskMeta({ ...meta, pid, status: 'running' });
}

export function markBackgroundTaskSpawnFailed(id: string, message: string): void {
  const meta = loadBackgroundTask(id);
  if (!meta) return;
  writeTaskMeta({
    ...meta,
    status: 'failed',
    finished_at: new Date().toISOString(),
    error: message,
  });
}

export function markBackgroundTaskExited(id: string, code: number | null, signal: NodeJS.Signals | null): void {
  const meta = loadBackgroundTask(id);
  if (!meta) return;
  writeTaskMeta({
    ...meta,
    status: meta.status === 'killed' ? 'killed' : 'finished',
    finished_at: new Date().toISOString(),
    exit_code: code,
    signal,
  });
}

export function markBackgroundTaskOutputLimitExceeded(meta: BackgroundTaskMeta): void {
  writeTaskMeta({
    ...meta,
    status: 'killed',
    finished_at: new Date().toISOString(),
    signal: 'SIGTERM',
    error: `output exceeded ${formatSize(MAX_BACKGROUND_OUTPUT_BYTES)}`,
  });
}

export function loadBackgroundTask(id: string): BackgroundTaskMeta | undefined {
  assertSafeTaskId(id);
  const filePath = getTaskMetaPath(id);
  if (!existsSync(filePath)) return undefined;
  const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as BackgroundTaskMeta;
  return refreshBackgroundTask(parsed);
}

export function listBackgroundTasks(
  options: {
    status?: BackgroundTaskStatus | 'all';
    limit?: number;
  } = {},
): BackgroundTaskMeta[] {
  const dir = getBackgroundTaskDir();
  if (!existsSync(dir)) return [];

  const tasks = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .flatMap((file): BackgroundTaskMeta[] => {
      const id = file.slice(0, -'.json'.length);
      try {
        if (!TASK_ID_PATTERN.test(id)) return [];
        const meta = loadBackgroundTask(id);
        return meta ? [meta] : [];
      } catch {
        return [];
      }
    })
    .filter((task) => options.status === undefined || options.status === 'all' || task.status === options.status)
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));

  return typeof options.limit === 'number' ? tasks.slice(0, options.limit) : tasks;
}

export function ensureBackgroundTaskMonitor(): void {
  registerBackgroundTaskExitCleanup();
  if (backgroundTaskMonitor) return;
  backgroundTaskMonitor = setInterval(() => {
    const shouldContinue = checkBackgroundTasksOnce();
    if (shouldContinue) return;
    clearBackgroundTaskMonitor();
  }, BACKGROUND_OUTPUT_WATCH_INTERVAL_MS);
  backgroundTaskMonitor.unref?.();
}

export function clearBackgroundTaskMonitor(): void {
  if (!backgroundTaskMonitor) return;
  clearInterval(backgroundTaskMonitor);
  backgroundTaskMonitor = null;
}

export async function terminateCurrentBackgroundTasks(
  options: { signal?: NodeJS.Signals; forceAfterMs?: number } = {},
): Promise<{ count: number; failed: number; stillRunning: number }> {
  const signal = options.signal ?? 'SIGTERM';
  const forceAfterMs = options.forceAfterMs ?? 1500;
  const tasks = listBackgroundTasks({ status: 'all' }).filter(isActiveBackgroundTask);
  if (tasks.length === 0) return { count: 0, failed: 0, stillRunning: 0 };

  const results = await Promise.allSettled(tasks.map((task) => killBackgroundTask(task.id, signal, forceAfterMs)));
  return {
    count: tasks.length,
    failed: results.filter((result) => result.status === 'rejected' || !result.value.ok).length,
    stillRunning: results.filter((result) => result.status === 'fulfilled' && result.value.stillRunning).length,
  };
}

function terminateCurrentBackgroundTasksSync(signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const task of listBackgroundTasks({ status: 'all' })) {
    if (!isActiveBackgroundTask(task) || !task.pid) continue;
    killProcessTree(task.pid, signal);
  }
}

function registerBackgroundTaskExitCleanup(): void {
  if (backgroundTaskExitCleanupRegistered) return;
  backgroundTaskExitCleanupRegistered = true;
  process.once('exit', () => terminateCurrentBackgroundTasksSync('SIGTERM'));
}

export function checkBackgroundTasksOnce(): boolean {
  const tasks = listBackgroundTasks({ status: 'all' });
  let hasLiveTask = false;

  for (const task of tasks) {
    if (!isActiveBackgroundTask(task)) continue;
    if (!isProcessAlive(task.pid)) continue;
    hasLiveTask = true;
    enforceBackgroundOutputLimit(task);
  }

  return hasLiveTask;
}

function isActiveBackgroundTask(task: BackgroundTaskMeta): boolean {
  return task.status === 'starting' || task.status === 'running';
}

export function getBackgroundTaskOutputSize(meta: BackgroundTaskMeta): number {
  try {
    return statSync(meta.output_path).size;
  } catch {
    return 0;
  }
}

export function readBackgroundTaskOutput(
  meta: BackgroundTaskMeta,
  options: { offset?: number; maxBytes: number; tailBytes?: number },
): OutputRange {
  const size = getBackgroundTaskOutputSize(meta);
  if (size === 0) {
    return { content: '', size, start: 0, end: 0 };
  }

  const requestedLength = Math.max(0, Math.min(options.tailBytes ?? options.maxBytes, options.maxBytes));
  const start =
    options.tailBytes !== undefined ? Math.max(0, size - requestedLength) : Math.min(options.offset ?? 0, size);
  const length = Math.max(0, Math.min(requestedLength, size - start));
  const buffer = Buffer.alloc(length);
  const fd = openSync(meta.output_path, 'r');
  try {
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return {
      content: buffer.subarray(0, bytesRead).toString('utf-8'),
      size,
      start,
      end: start + bytesRead,
    };
  } finally {
    closeSync(fd);
  }
}

export async function killBackgroundTask(
  id: string,
  signal: NodeJS.Signals,
  forceAfterMs: number,
): Promise<{ ok: boolean; message: string; meta?: BackgroundTaskMeta; stillRunning?: boolean }> {
  const meta = loadBackgroundTask(id);
  if (!meta) return { ok: false, message: `未知后台任务: ${id}` };

  if (!['starting', 'running'].includes(meta.status)) {
    return { ok: false, message: `后台任务 ${id} 当前状态为 ${meta.status}，无需终止。`, meta };
  }
  if (!meta.pid) {
    markBackgroundTaskSpawnFailed(id, 'missing pid');
    return { ok: false, message: `后台任务 ${id} 没有记录 pid，无法终止。`, meta: loadBackgroundTask(id) };
  }

  appendFileSync(
    meta.output_path,
    [
      '',
      '[mica background task kill requested]',
      `requested_at: ${new Date().toISOString()}`,
      `signal: ${signal}`,
      '',
    ].join('\n'),
    'utf-8',
  );

  const sent = killProcessTree(meta.pid, signal);
  if (!sent) {
    const refreshed = loadBackgroundTask(id) ?? meta;
    return { ok: false, message: `后台任务 ${id} 的进程已不存在。`, meta: refreshed };
  }

  if (signal === 'SIGKILL') {
    await new Promise((resolve) => setTimeout(resolve, 100));
  } else if (forceAfterMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, forceAfterMs));
    if (isProcessAlive(meta.pid)) {
      killProcessTree(meta.pid, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const stillRunning = isProcessAlive(meta.pid);
  const latest = loadBackgroundTask(id) ?? meta;
  if (stillRunning) {
    return { ok: true, message: `已发送 ${signal}，但任务仍在运行。`, meta: latest, stillRunning };
  }

  const killed: BackgroundTaskMeta = {
    ...latest,
    status: 'killed',
    finished_at: latest.finished_at ?? new Date().toISOString(),
    signal: latest.signal ?? signal,
  };
  writeTaskMeta(killed);
  return { ok: true, message: `已终止后台任务 ${id}。`, meta: killed, stillRunning };
}

export function waitForBackgroundSpawn(child: ChildProcess): Promise<{ ok: true } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: true } | { ok: false; message: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('spawn', onSpawn);
      child.off('error', onError);
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: true }), 50);
    timer.unref?.();
    const onSpawn = () => finish({ ok: true });
    const onError = (error: Error) => finish({ ok: false, message: error.message });
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

export function killChildProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  killProcessTree(child.pid, signal);
}

function refreshBackgroundTask(meta: BackgroundTaskMeta): BackgroundTaskMeta {
  if (!['starting', 'running'].includes(meta.status)) return meta;
  const output = readBackgroundTaskExitMarker(meta.output_path, meta.id);
  if (output) {
    const refreshed: BackgroundTaskMeta = {
      ...meta,
      status: meta.status === 'killed' ? 'killed' : 'finished',
      finished_at: meta.finished_at ?? output.finishedAt ?? new Date().toISOString(),
      exit_code: output.exitCode,
      signal: output.signal,
    };
    writeTaskMeta(refreshed);
    return refreshed;
  }

  if (isProcessAlive(meta.pid)) return meta.status === 'starting' && meta.pid ? { ...meta, status: 'running' } : meta;

  const refreshed: BackgroundTaskMeta = {
    ...meta,
    status: 'unknown_exited',
    finished_at: meta.finished_at ?? new Date().toISOString(),
  };
  writeTaskMeta(refreshed);
  return refreshed;
}

function enforceBackgroundOutputLimit(meta: BackgroundTaskMeta): void {
  try {
    const size = statSync(meta.output_path).size;
    if (size <= MAX_BACKGROUND_OUTPUT_BYTES) return;
    appendFileSync(
      meta.output_path,
      `\n[mica background task stopped]\nreason: output exceeded ${formatSize(MAX_BACKGROUND_OUTPUT_BYTES)}\n`,
      'utf-8',
    );
    markBackgroundTaskOutputLimitExceeded(meta);
    if (meta.pid) {
      killProcessTree(meta.pid, 'SIGTERM');
      setTimeout(() => {
        if (isProcessAlive(meta.pid)) killProcessTree(meta.pid!, 'SIGKILL');
      }, 5_000).unref?.();
    }
  } catch {
    // A task can finish and rotate metadata between list and size checks.
  }
}

function readBackgroundTaskExitMarker(
  outputPath: string,
  id?: string,
): {
  finishedAt?: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
} | null {
  let content: string;
  try {
    const size = statSync(outputPath).size;
    const length = Math.min(size, 4096);
    const buffer = Buffer.alloc(length);
    const fd = openSync(outputPath, 'r');
    try {
      const bytesRead = readSync(fd, buffer, 0, length, size - length);
      content = buffer.subarray(0, bytesRead).toString('utf-8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }

  const markerIndex = content.lastIndexOf('[mica background task exited]');
  if (markerIndex < 0) return null;
  const marker = content.slice(markerIndex);
  const markerId = marker.match(/^id: (.+)$/m)?.[1]?.trim();
  if (id && markerId && markerId !== id) return null;
  return {
    finishedAt: marker.match(/^finished_at: (.+)$/m)?.[1]?.trim(),
    exitCode: parseNullableNumber(marker.match(/^exit_code: (.+)$/m)?.[1]),
    signal: parseNullableSignal(marker.match(/^signal: (.+)$/m)?.[1]),
  };
}

function parseNullableNumber(value: string | undefined): number | null {
  if (!value || value.trim() === 'null') return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNullableSignal(value: string | undefined): NodeJS.Signals | null {
  if (!value || value.trim() === 'null') return null;
  return value.trim() as NodeJS.Signals;
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        // Fall through to checking the direct process id.
      }
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(pid: number, signal: NodeJS.Signals): boolean {
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (signal === 'SIGKILL') args.push('/F');
    const result = spawnSync('taskkill', args, { stdio: 'ignore' });
    return result.status === 0;
  }

  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}
