import { spawn } from 'node:child_process';
import { openSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR_NAME } from '@packages/mica-config/brand.js';
import { loadDaemonConfig } from './config.js';

export function daemonPidPath(): string {
  const micaHome = process.env.MICA_HOME
    ? resolveHome(process.env.MICA_HOME)
    : join(homedir(), CONFIG_DIR_NAME);
  return join(micaHome, 'daemon.pid');
}

function resolveHome(value: string): string {
  return value === '~' ? join(homedir(), CONFIG_DIR_NAME) : resolve(value);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readDaemonPid(): number {
  return readPid(daemonPidPath());
}

export function readPid(path: string): number {
  try {
    const value = Number.parseInt(readFileSync(path, 'utf-8').trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

export function writeDaemonPid(pid: number): void {
  const path = daemonPidPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${pid}\n`, 'utf-8');
}

export function removeDaemonPid(): void {
  try {
    unlinkSync(daemonPidPath());
  } catch {
    // Already gone.
  }
}

/**
 * True when the daemon should be started: no pid file, or the recorded pid is
 * no longer alive (daemon was killed/crashed; the stale file is overwritten).
 */
export function daemonShouldStart(pidPath: string): boolean {
  const existing = readPid(pidPath);
  return !(existing > 0 && isPidAlive(existing));
}

/**
 * Start the sync daemon in the background if it is not already running.
 * Called on every interactive `mica` invocation (only when a sync server is
 * configured via sync.json), so the web console always sees the local machine
 * online without launchd/cron. Best-effort and silent: it never blocks or
 * fails the interactive session. `MICA_NO_DAEMON=1` disables it (CI/test).
 */
export async function ensureDaemonRunning(): Promise<void> {
  try {
    if (process.env.MICA_NO_DAEMON) return;
    const config = loadDaemonConfig();
    if (!config) return; // No sync server configured.
    if (!daemonShouldStart(daemonPidPath())) return;

    const logPath = join(dirname(daemonPidPath()), 'daemon.log');
    const logFd = openSync(logPath, 'a');
    const isBunRuntime = process.execPath.includes('bun');
    const args = isBunRuntime
      ? ['run', join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'daemon']
      : ['daemon'];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
    child.unref();
  } catch {
    // Best-effort only: a failed daemon start must not break `mica`.
  }
}
