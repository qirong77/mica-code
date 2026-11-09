import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { WATCHDOG_SOURCE } from './watchdogSource.js';

const DEFAULT_EXECUTABLE = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
const WATCHDOG_NAME = 'watchdog.mjs';
const LOCK_NAME = 'deepseek-harness.lock';
const STATUS_NAME = 'data.json';
const RETRY_NAME = 'retry.json';
const RETRY_BASE_MS = 10_000;
const RETRY_MAX_MS = 300_000;
const STABLE_MS = 60_000;
const START_TIMEOUT_MS = 30_000;
const START_FAILURE_PREFIX = 'DeepSeek Harness 启动失败：';
const FAILURE_STATUS_PREFIX = 'DeepSeek Harness 失败状态写入失败：';
const MISSING_EXECUTABLE_MESSAGE = '未找到 DeepSeek Harness，可在插件设置中填写可执行文件路径。';

export type HarnessSettings = { enabled?: unknown; executable?: unknown; port?: unknown };
export type HarnessStatus = Record<string, unknown>;
type LockRecord = { pid: number; ownerPid: number; fingerprint: string; startedAt: number };
type RetryRecord = { key: string; failures: number; retryAt: number };
type OwnedProcess = { child: ChildProcess; lock: LockRecord; executable: string; retryKey: string; failure?: string };
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
    if (!Number.isInteger(value.pid) || !Number.isInteger(value.ownerPid) || typeof value.fingerprint !== 'string')
      return null;
    return {
      pid: value.pid!,
      ownerPid: value.ownerPid!,
      fingerprint: value.fingerprint,
      startedAt: Number(value.startedAt) || 0,
    };
  } catch {
    return null;
  }
}

function remove(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {}
}

function sameLock(left: LockRecord | null, right: LockRecord): boolean {
  return (
    left?.pid === right.pid &&
    left.ownerPid === right.ownerPid &&
    left.fingerprint === right.fingerprint &&
    left.startedAt === right.startedAt
  );
}

function readRetry(path: string): RetryRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as RetryRecord;
    if (
      typeof value.key !== 'string' ||
      !Number.isInteger(value.failures) ||
      value.failures < 1 ||
      !Number.isFinite(value.retryAt)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

function ready(dataDir: string, lock: LockRecord, executable: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, STATUS_NAME), 'utf8'));
    return (
      value.state?.text === '运行中' &&
      value.state?.tone === 'ok' &&
      value.process?.text === `DeepSeek Harness watchdog ${lock.pid}` &&
      value.process?.tone === 'ok' &&
      value.executable === executable &&
      typeof value.address === 'string' &&
      ['http:', 'https:'].includes(new URL(value.address).protocol)
    );
  } catch {
    return false;
  }
}

export function isSupervisorHealthIssue(report: { level: string; message: string }): boolean {
  return (
    (report.level === 'error' &&
      (report.message.startsWith(START_FAILURE_PREFIX) || report.message.startsWith(FAILURE_STATUS_PREFIX))) ||
    (report.level === 'warn' && report.message === MISSING_EXECUTABLE_MESSAGE)
  );
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
  recover?: () => void;
  spawn?: SpawnLike;
  parentPid?: number;
  nodeBin?: string;
}): HarnessSupervisor {
  const { dataDir, getSettings, report } = options;
  const lockPath = join(dataDir, LOCK_NAME);
  const guardPath = `${lockPath}.guard`;
  const retryPath = join(dataDir, RETRY_NAME);
  const spawn = options.spawn ?? nodeSpawn;
  const parentPid = options.parentPid ?? process.pid;
  let disposed = false;
  let owned: OwnedProcess | null = null;

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
    const enabled = String(values.enabled ?? 'true') !== 'false';
    const nodeBin = options.nodeBin || process.env.MICA_DEEPSEEK_NODE || 'node';
    return {
      enabled,
      executable,
      port,
      nodeBin,
      fingerprint: `${executable ?? ''}|${port}`,
      retryKey: JSON.stringify([enabled, configured, executable, port, nodeBin]),
    };
  };

  const status = (state: string, tone: 'ok' | 'warn' | 'error', executable: string | null, pid?: number) => {
    writeStatus(dataDir, {
      state: { text: state, tone },
      process: { text: pid ? `DeepSeek Harness watchdog ${pid}` : '未运行', tone },
      executable: executable ?? '未找到',
    });
  };

  const stopOwned = (): OwnedProcess | null => {
    const attempt = owned;
    owned = null;
    try {
      attempt?.child.kill('SIGTERM');
    } catch {}
    return attempt;
  };

  const stopRunning = (allowShared = false): boolean => {
    const attempt = stopOwned();
    if (attempt) {
      const lock = readLock(lockPath);
      if (sameLock(lock, attempt.lock)) remove(lockPath);
      return true;
    }
    const lock = readLock(lockPath);
    if (lock?.pid === 0 && alive(lock.ownerPid)) return false;
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

  const failed = (lock: LockRecord, executable: string, retryKey: string, message: string): void => {
    const ownsLock = sameLock(readLock(lockPath), lock);
    if (owned && sameLock(owned.lock, lock)) stopRunning();
    if (!ownsLock) return;
    const previous = readRetry(retryPath);
    const failures =
      previous?.key === retryKey && Date.now() - lock.startedAt < STABLE_MS ? Math.min(previous.failures + 1, 6) : 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
    try {
      writeFileSync(retryPath, JSON.stringify({ key: retryKey, failures, retryAt: Date.now() + delay }), {
        mode: 0o600,
      });
    } finally {
      if (sameLock(readLock(lockPath), lock)) remove(lockPath);
    }
    status(`启动失败，${delay / 1000} 秒后重试`, 'error', executable);
    report?.('error', `${START_FAILURE_PREFIX}${message}；${delay / 1000} 秒后重试。`);
  };

  const start = (executable: string, port: number, fingerprint: string, retryKey: string, nodeBin: string): void => {
    mkdirSync(dataDir, { recursive: true });
    const reservation: LockRecord = { pid: 0, ownerPid: parentPid, fingerprint, startedAt: Date.now() };
    try {
      writeFileSync(lockPath, JSON.stringify(reservation), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw error;
    }
    let attempt: OwnedProcess | null = null;
    try {
      const watchdog = materializeWatchdog(dataDir);
      const child = spawn(nodeBin, [watchdog], {
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
      const started: OwnedProcess = { child, lock: reservation, executable, retryKey };
      attempt = started;
      owned = started;
      const onFailure = (message: string) => {
        if (owned !== started || started.failure) return;
        started.failure = message;
        try {
          guarded(undefined, () => failed(started.lock, executable, retryKey, message));
        } catch (error) {
          report?.('error', `${FAILURE_STATUS_PREFIX}${String(error)}`);
        }
      };
      child.on('error', (error) => onFailure(`${error.message}；请检查 Node.js / MICA_DEEPSEEK_NODE。`));
      child.on('exit', (code, signal) => onFailure(`watchdog 已退出（${signal ?? code ?? 'unknown'}）`));
      if (!child.pid) throw new Error('Node.js 未返回进程 PID，请检查 PATH / MICA_DEEPSEEK_NODE。');
      const running = { ...reservation, pid: child.pid };
      writeFileSync(lockPath, JSON.stringify(running), { mode: 0o600 });
      started.lock = running;
      status('启动中', 'warn', executable, child.pid);
      child.unref();
    } catch (error) {
      failed(
        attempt?.lock ?? reservation,
        executable,
        retryKey,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const ensure = () =>
    guarded(undefined, () => {
      if (disposed) return;
      if (owned?.failure) failed(owned.lock, owned.executable, owned.retryKey, owned.failure);
      const current = config();
      const retry = readRetry(retryPath);
      if (retry && (retry.key !== current.retryKey || !current.enabled)) remove(retryPath);
      if (!current.enabled) {
        stopRunning();
        status('已禁用', 'warn', current.executable);
        return;
      }
      if (!current.executable) {
        stopRunning();
        status('未找到可执行文件', 'warn', null);
        report?.('warn', MISSING_EXECUTABLE_MESSAGE);
        return;
      }
      const lock = readLock(lockPath);
      if (lock && lock.pid > 0 && alive(lock.pid)) {
        if (lock.fingerprint !== current.fingerprint) stopRunning(true);
        else {
          if (Date.now() - lock.startedAt >= STABLE_MS) remove(retryPath);
          if (ready(dataDir, lock, current.executable)) options.recover?.();
          return;
        }
      } else if (lock?.pid === 0 && alive(lock.ownerPid) && Date.now() - lock.startedAt < START_TIMEOUT_MS) {
        return;
      } else if (lock) {
        if (lock.fingerprint === current.fingerprint && alive(lock.ownerPid)) {
          failed(lock, current.executable, current.retryKey, 'watchdog 未存活或启动锁已超时');
          return;
        }
        if (owned && sameLock(owned.lock, lock)) stopRunning();
        else remove(lockPath);
      }
      if (retry?.key === current.retryKey && Date.now() < retry.retryAt) return;
      start(current.executable, current.port, current.fingerprint, current.retryKey, current.nodeBin);
    });

  return {
    ensure,
    runningPid: () =>
      guarded<number | null>(null, () => {
        const lock = readLock(lockPath);
        return lock && lock.pid > 0 && alive(lock.pid) ? lock.pid : null;
      }),
    dispose: () => {
      disposed = true;
      const attempt = stopOwned();
      if (!attempt) return;
      guarded(undefined, () => {
        if (sameLock(readLock(lockPath), attempt.lock)) remove(lockPath);
      });
    },
  };
}

export { DEFAULT_EXECUTABLE, LOCK_NAME, WATCHDOG_NAME };
