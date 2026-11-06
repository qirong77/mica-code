import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { WATCHDOG_SOURCE } from './watchdogSource.js';

const DEFAULT_EXECUTABLE = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const WATCHDOG_NAME = 'watchdog.mjs';
const LOCK_NAME = 'deepseek-harness.lock';
const STATUS_NAME = 'data.json';

export type HarnessSettings = { enabled?: unknown; executable?: unknown; port?: unknown };
export type HarnessStatus = Record<string, unknown>;
type LockRecord = { pid: number; ownerPid: number; fingerprint: string; startedAt: number };
type SpawnLike = typeof nodeSpawn;

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function executableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findExecutable(configured: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const requested = configured.trim();
  if (requested) {
    if (requested.includes('/')) return executableFile(requested) ? requested : null;
    for (const dir of (env.PATH ?? '').split(':')) {
      const candidate = join(dir, requested);
      if (executableFile(candidate)) return candidate;
    }
    return null;
  }
  for (const dir of (env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'dsh');
    if (executableFile(candidate)) return candidate;
  }
  if (executableFile(DEFAULT_EXECUTABLE)) return DEFAULT_EXECUTABLE;
  return null;
}

export function harnessAddressFromOutput(output: string): string | null {
  const match = output.match(/dsh web:\s+(https?:\/\/[^\s]+)/);
  if (!match) return null;
  try {
    return new URL(match[1]).toString();
  } catch {
    return null;
  }
}

export function materializeWatchdog(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const target = join(dataDir, WATCHDOG_NAME);
  try {
    if (readFileSync(target, 'utf8') === WATCHDOG_SOURCE) return target;
  } catch {}
  writeFileSync(target, WATCHDOG_SOURCE, { mode: 0o700 });
  return target;
}

export function writeStatus(dataDir: string, status: HarnessStatus): void {
  mkdirSync(dataDir, { recursive: true });
  const target = join(dataDir, STATUS_NAME);
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function readLock(path: string): LockRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockRecord>;
    if (!Number.isInteger(value.pid) || !Number.isInteger(value.ownerPid) || typeof value.fingerprint !== 'string') return null;
    return { pid: value.pid!, ownerPid: value.ownerPid!, fingerprint: value.fingerprint, startedAt: Number(value.startedAt) || 0 };
  } catch {
    return null;
  }
}

function remove(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {}
}

export type HarnessSupervisor = {
  ensure(): void;
  dispose(): void;
  runningPid(): number | null;
};

export function createHarnessSupervisor(options: {
  dataDir: string;
  getSettings: () => HarnessSettings;
  report?: (level: 'warn' | 'error', message: string) => void;
  spawn?: SpawnLike;
  parentPid?: number;
  nodeBin?: string;
}): HarnessSupervisor {
  const { dataDir, getSettings, report } = options;
  const lockPath = join(dataDir, LOCK_NAME);
  const guardPath = `${lockPath}.guard`;
  const spawn = options.spawn ?? nodeSpawn;
  const parentPid = options.parentPid ?? process.pid;
  const nodeBin = options.nodeBin ?? process.execPath;
  let disposed = false;
  let ownedPid: number | null = null;
  let ownedChild: ChildProcess | null = null;

  const guarded = <T>(fallback: T, action: () => T): T => {
    const release = acquireProcessLock(guardPath);
    if (!release) return fallback;
    try {
      return action();
    } finally {
      release();
    }
  };

  const config = () => {
    const values = getSettings();
    const configured = String(values.executable ?? '').trim();
    const executable = findExecutable(configured);
    const parsedPort = Number(values.port ?? 0);
    const port = Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535 ? parsedPort : 0;
    return { enabled: String(values.enabled ?? 'true') !== 'false', executable, port, fingerprint: `${executable ?? ''}|${port}` };
  };

  const status = (state: string, tone: 'ok' | 'warn' | 'error', executable: string | null, pid?: number) => {
    writeStatus(dataDir, {
      state: { text: state, tone },
      process: { text: pid ? `DeepSeek Harness watchdog ${pid}` : '未运行', tone },
      executable: executable ?? '未找到',
    });
  };

  const stopRunning = (allowShared = false): boolean => {
    if (ownedPid !== null) {
      const pid = ownedPid;
      try {
        ownedChild?.kill('SIGTERM');
      } catch {}
      const lock = readLock(lockPath);
      if (lock?.pid === pid && lock.ownerPid === parentPid) remove(lockPath);
      ownedPid = null;
      ownedChild = null;
      return true;
    }
    const lock = readLock(lockPath);
    if (!lock || lock.pid <= 0 || !alive(lock.pid)) {
      if (lock) remove(lockPath);
      return false;
    }
    if (allowShared) {
      try {
        process.kill(lock.pid, 'SIGTERM');
      } catch {}
      remove(lockPath);
      return true;
    }
    return false;
  };

  const start = (executable: string, port: number, fingerprint: string): void => {
    mkdirSync(dataDir, { recursive: true });
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: 0, ownerPid: parentPid, fingerprint, startedAt: Date.now() }), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw error;
    }
    const watchdog = materializeWatchdog(dataDir);
    let child: ChildProcess;
    try {
      child = spawn(nodeBin, [watchdog], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          MICA_DEEPSEEK_EXECUTABLE: executable,
          MICA_DEEPSEEK_DATA_DIR: dataDir,
          MICA_DEEPSEEK_PORT: String(port),
          MICA_DEEPSEEK_PARENT_PID: String(parentPid),
        },
      });
    } catch (error) {
      remove(lockPath);
      throw error;
    }
    if (!child.pid) {
      remove(lockPath);
      return;
    }
    ownedPid = child.pid;
    ownedChild = child;
    writeFileSync(lockPath, JSON.stringify({ pid: child.pid, ownerPid: parentPid, fingerprint, startedAt: Date.now() }), { mode: 0o600 });
    status('启动中', 'warn', executable, child.pid);
    child.on('error', (error) => {
      report?.('error', `DeepSeek Harness 启动失败：${error instanceof Error ? error.message : String(error)}`);
    });
    child.on('exit', () => {
      if (ownedPid === child.pid) {
        ownedPid = null;
        ownedChild = null;
        const lock = readLock(lockPath);
        if (lock?.pid === child.pid) remove(lockPath);
      }
    });
    child.unref();
  };

  const ensure = () => guarded(undefined, () => {
    if (disposed) return;
    const current = config();
    if (!current.enabled) {
      stopRunning();
      status('已禁用', 'warn', current.executable);
      return;
    }
    if (!current.executable) {
      stopRunning();
      status('未找到可执行文件', 'warn', null);
      report?.('warn', '未找到 DeepSeek Harness，可在插件设置中填写可执行文件路径。');
      return;
    }
    const lock = readLock(lockPath);
    if (lock && lock.pid > 0 && alive(lock.pid)) {
      if (lock.fingerprint !== current.fingerprint) stopRunning(true);
      else return;
    } else if (lock?.pid === 0 && alive(lock.ownerPid)) {
      return;
    } else if (lock) {
      remove(lockPath);
    }
    start(current.executable, current.port, current.fingerprint);
  });

  return {
    ensure,
    runningPid: () => guarded<number | null>(null, () => {
      const lock = readLock(lockPath);
      return lock && lock.pid > 0 && alive(lock.pid) ? lock.pid : null;
    }),
    dispose: () => {
      disposed = true;
      guarded(undefined, () => {
        stopRunning();
        if (ownedPid === null) ownedChild = null;
      });
    },
  };
}

export { DEFAULT_EXECUTABLE, LOCK_NAME, WATCHDOG_NAME };
