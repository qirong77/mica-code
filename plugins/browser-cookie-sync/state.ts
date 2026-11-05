import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import type { Baseline, BaselineEntry } from './merge.js';

/**
 * 同步基线 + 上一次结果。**只存指纹，不存 cookie 值**。
 *
 * 写它有两个来源：面板上的「立即同步」（`mica plugin-action` 一次性进程）与后台那一轮
 * （会话进程）。两者互不相识，所以共用一把跨进程锁 + 先写临时文件再 rename
 * （面板随时在读，不能让它读到半份 JSON）。
 */

export const STATE_FILE = 'state.json';
export const STATE_VERSION = 2;
/** 一份基线最多多少条：Chrome 里几千条是常态，十万条说明真的该收窄范围了。 */
const MAX_ENTRIES = 100_000;
const LOCK_ATTEMPTS = 6;
const LOCK_RETRY_MS = 80;

export type LastRun = {
  at: string;
  dryRun: boolean;
  /** 四个方向的计数，面板与状态行都读它。 */
  counts: {
    chrome: number;
    mica: number;
    toChrome: number;
    toMica: number;
    removedFromChrome: number;
    removedFromMica: number;
    conflicts: number;
    unchanged: number;
  };
  /** 冲突条目（只留定位信息，供面板列出后一键选边）。 */
  conflicts: { key: string; host: string; name: string; path: string }[];
  /** 没做成的事：Chrome 在运行、方向关着、钥匙串被拒… */
  notes: string[];
};

export type SyncState = {
  version: number;
  updatedAt: string;
  baseline: Baseline;
  lastRun: LastRun | null;
};

export function stateFilePath(dataDir: string): string {
  return join(dataDir, STATE_FILE);
}

export function emptyState(): SyncState {
  return { version: STATE_VERSION, updatedAt: '', baseline: {}, lastRun: null };
}

export function readState(file: string): SyncState {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SyncState>;
    const baseline: Baseline = {};
    for (const [key, value] of Object.entries(parsed.baseline ?? {})) {
      const entry = value as Partial<BaselineEntry>;
      if (typeof entry?.c === 'string' && typeof entry?.m === 'string') {
        baseline[key] = { c: entry.c, m: entry.m };
      }
    }
    return {
      version: STATE_VERSION,
      updatedAt: String(parsed.updatedAt || ''),
      baseline,
      lastRun: (parsed.lastRun as LastRun | null) ?? null
    };
  } catch {
    return emptyState();
  }
}

/** 超过上限就按字典序丢掉多余的那批：cookie 的键是有序的，丢哪一半并不影响正确性。 */
function trimEntries(baseline: Baseline): Baseline {
  const keys = Object.keys(baseline);
  if (keys.length <= MAX_ENTRIES) return baseline;
  const keep = new Set(keys.sort().slice(0, MAX_ENTRIES));
  const next: Baseline = {};
  for (const key of keys) if (keep.has(key)) next[key] = baseline[key]!;
  return next;
}

export function writeState(file: string, state: SyncState): void {
  mkdirSync(dirname(file), { recursive: true });
  const payload: SyncState = {
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
    baseline: trimEntries(state.baseline),
    lastRun: state.lastRun
  };
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(payload)}\n`, 'utf8');
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 在跨进程锁里读改写一次。
 *
 * 锁拿不到只说明另一路正在写（用户刚点了按钮、后台那一轮刚好在跑）：等几十毫秒重试，
 * 而不是让这一轮白跑。
 */
export async function mutateState(
  file: string,
  mutate: (state: SyncState) => SyncState
): Promise<SyncState> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    const release = acquireProcessLock(`${file}.lock`);
    if (!release) {
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    try {
      const next = mutate(readState(file));
      writeState(file, next);
      return next;
    } finally {
      release();
    }
  }
  throw new Error('同步状态正被另一个进程写（刚点过同步？），稍后再试');
}
