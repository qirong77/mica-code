import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMicaHome } from '@packages/mica-config/brand.js';
import { micaSession } from '@packages/mica-session/index.js';

export const GC_INTERVAL_MS = 5 * 60_000;
export const GC_PID_FILE = 'session-gc.pid';
export const GC_LOG_FILE = 'session-gc.log';

function gcPidPath(): string {
  return join(resolveMicaHome(), GC_PID_FILE);
}

function gcLogPath(): string {
  return join(resolveMicaHome(), GC_LOG_FILE);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readGcPid(): number {
  try {
    const value = Number.parseInt(readFileSync(gcPidPath(), 'utf8').trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function writeGcPid(pid: number): void {
  const path = gcPidPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${pid}\n`, 'utf8');
}

export function removeGcPid(): void {
  try {
    unlinkSync(gcPidPath());
  } catch {
    // Already gone.
  }
}

function log(message: string): void {
  console.log(`[mica-gc ${new Date().toISOString()}] ${message}`);
}

function logError(message: string): void {
  console.error(`[mica-gc ${new Date().toISOString()}] ${message}`);
}

/**
 * `mica gc` 单实例守护：用 `~/.mica/session-gc.pid` 互斥，任何时刻至多一个
 * 实例在运行。被强杀后 pid 文件残留，下一个实例启动时用 isPidAlive 判定接管。
 */
export async function runSessionGc(): Promise<void> {
  const runningPid = readGcPid();
  if (runningPid && runningPid !== process.pid && isPidAlive(runningPid)) {
    logError(`already running (pid ${runningPid}); refusing to start a second instance`);
    process.exit(0);
  }
  writeGcPid(process.pid);
  process.on('exit', removeGcPid);

  const store = micaSession.createStore();
  const sweep = (): void => {
    try {
      const result = store.performGarbageCollection();
      if (result.reclaimedLocks || result.demotedSessions || result.deletedSessions) {
        log(
          `reclaimedLocks=${result.reclaimedLocks} demotedSessions=${result.demotedSessions} ` +
            `deletedSessions=${result.deletedSessions}`,
        );
      }
    } catch (error) {
      logError(`sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  sweep();
  const timer = setInterval(sweep, GC_INTERVAL_MS);
  // Timer is unref'd so a lone GC daemon can still be killed cleanly; the
  // never-resolving promise below keeps the event loop alive regardless.
  timer.unref?.();

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    removeGcPid();
    log('shutting down');
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  log(`session-gc daemon running (pid ${process.pid}) — sweep every ${GC_INTERVAL_MS / 1000}s`);
  await new Promise(() => undefined);
}

/**
 * 在交互式 mica 启动时 fire-and-forget 拉起的 GC 守护。若已有实例在跑则直接
 * 跳过；否则后台 spawn 一个 detached 子进程执行 `mica gc`，不阻塞、不失败
 * 当前会话。`MICA_NO_GC=1` 可禁用（CI/测试）。
 */
export function ensureGcRunning(): void {
  try {
    if (process.env.MICA_NO_GC) return;
    if (!daemonShouldStart()) return;

    const logFd = openSync(gcLogPath(), 'a');
    const isBunRuntime = process.execPath.includes('bun');
    const args = isBunRuntime
      ? ['run', join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'gc']
      : ['gc'];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
    child.unref();
  } catch {
    // Best-effort only: a failed gc daemon start must not break `mica`.
  }
}

export function daemonShouldStart(): boolean {
  const existing = readGcPid();
  return !(existing > 0 && isPidAlive(existing));
}
