// 本机诊断日志：桌面运行时（host / server）、Electron 主进程、CLI（TUI / `mica exec` /
// `mica app-server`）共用的唯一写入器。
//
// 目标不是遥测，而是「事后能查」。所以：
// - 位置由 `resolveLogDir()` 决定（macOS `~/Library/Logs/mica`），不写系统 temp：
//   temp 每次登录被系统清空，重启就只剩当次运行，跨天的问题无法回头查；
// - JSONL 一行一个事件，直接 tail / grep / jq 就能看；
// - 内存排队 + 定时批量落盘，高频事件（如流式输出）不会把主线程拖慢；
// - 同时保留最近 N 条在内存里，供 `diagnostics:snapshot` 立刻取现场。
//
// 慢操作单独聚合：调用方用 `timed()` 包一层，超过阈值自动记一条 slow，
// 并累加到 `slowReport()`，用来回答「到底哪个功能在拖慢」。
//
// 内存单独一条线（`scope: 'mem'`，见 `startMemorySampler()`）：每个常驻进程自己上报
// `process.memoryUsage()`，配置页 Performance 据此画「谁在涨」。
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { resolveLogDir } from '@packages/mica-config/brand.js';

const MAX_BYTES = 16 * 1024 * 1024;
const KEEP_DAYS = 7;
// 常态化保留之后目录会跨天累积，再加一道总容量兜底：超了从最旧的开始删。
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
// 清理跑在 flush 里（每 2s），但扫描目录没必要这么勤。
const PRUNE_MS = 60 * 60 * 1000;
const RING_SIZE = 1000;
const FLUSH_MS = 2000;
const FLUSH_BATCH = 100;
// 默认内存采样间隔：够看出「一个会话跑了 4 小时涨了 1GB」，又不会让日志变噪音。
const MEM_INTERVAL_MS = 30_000;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LEVEL = (process.env.MICA_LOG_LEVEL || 'info').toLowerCase();
// 默认只看 warn 以上；排查时用 MICA_LOG_LEVEL=debug 打开全量。
let threshold = LEVELS[DEFAULT_LEVEL as LogLevel] ?? LEVELS.info;
// 慢操作阈值：超过就记为 slow（host 通道一次调用通常 < 50ms）。
export const SLOW_MS = Number(process.env.MICA_LOG_SLOW_MS || 300);

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  at: number;
  level: LogLevel;
  scope: string;
  event: string;
  [field: string]: unknown;
}

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  timed<T>(event: string, fn: () => Promise<T>, threshold?: number): Promise<T>;
  timedResult<T>(event: string, fn: () => Promise<T>, threshold?: number): Promise<T>;
}

export interface PerfTimelinePoint {
  at: number;
  lag: number;
  long: number;
  longN: number;
  dom: number;
  heapMB?: number;
  rows?: number;
  sid?: string;
}

export interface PerfMemoryPoint {
  at: number;
  rssMB: number;
  heapMB: number;
  externalMB: number;
  pid: number;
  host: string;
}

export interface PerfMemoryProcess {
  key: string;
  host: string;
  pid: number;
  session?: string;
  samples: number;
  lastRssMB: number;
  peakRssMB: number;
  firstRssMB: number;
  lastHeapMB: number;
  lastExternalMB: number;
  /** 窗口内第一条与最后一条 RSS 的差（MB）：正数就是在涨。 */
  growthMB: number;
}

export interface PerfBucket {
  scope: string;
  event: string;
  count: number;
  slow: number;
  fails: number;
  avgMs: number;
  maxMs: number;
}

export interface PerfEvent {
  at: number;
  level: string;
  scope: string;
  event: string;
  ms?: number;
  lag?: number | null;
  long?: number;
  longN?: number;
  dom?: number;
  rows?: number;
  heapMB?: number;
  vis?: number;
  count?: number;
  error?: unknown;
  sid?: string;
  rssMB?: number;
}

export interface PerfMetrics {
  available: boolean;
  dir: string;
  files: Array<{ name: string; bytes: number; modifiedAt: number }>;
  totals: {
    events: number;
    errors: number;
    warns: number;
    slowCalls: number;
    samples: number;
    hiddenSamples: number;
    spanMs: number;
    memSamples: number;
    peakRssMB: number;
  };
  pending: number;
  buckets: PerfBucket[];
  timeline: PerfTimelinePoint[];
  memory: PerfMemoryPoint[];
  processes: PerfMemoryProcess[];
  events: PerfEvent[];
}

let queue: LogEntry[] = [];
let ring: LogEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let slowStats = new Map<string, { count: number; totalMs: number; maxMs: number; slow: number; fails: number }>();
let dropped = 0;
let lastPrune = 0;
let lastPruneDir = '';
// 每个 scope 当天正在写的文件。分片必须按序号递增，不能按时间戳算文件名：
// 日文件一满，按 flush 时刻取名等于每 2s 新建一个文件（一天几千个）。
const activeFiles = new Map<string, string>();

function logDir(): string {
  const dir = resolveLogDir();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    // 目录建不出来时让它抛在 appendFileSync 里，按「本批丢弃」处理，不影响调用方
  }
  return dir;
}

function dayStamp(now: number): string {
  const d = new Date(now);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('');
}

function fileFor(scope: string, now: number): string {
  const dir = logDir();
  const key = `${scope}-${dayStamp(now)}`;
  const cached = activeFiles.get(key);
  if (cached) {
    try {
      if (statSync(cached).size <= MAX_BYTES) return cached;
    } catch {
      // 被清理或挪走，重新找一片
    }
  }
  for (let part = 0; part < 1000; part += 1) {
    const path = part === 0 ? join(dir, `${key}.jsonl`) : join(dir, `${key}-${part}.jsonl`);
    try {
      if (statSync(path).size > MAX_BYTES) continue;
    } catch {
      // 不存在就用它
    }
    activeFiles.set(key, path);
    return path;
  }
  return join(dir, `${key}.jsonl`);
}

// 保留期 + 总容量兜底清理。
function prune(now: number): void {
  const dir = logDir();
  // 换了目录（MICA_LOG_DIR 覆盖、隔离实例）就立即清一次，别让上一个目录的节流带过来。
  if (dir === lastPruneDir && now - lastPrune < PRUNE_MS) return;
  lastPrune = now;
  lastPruneDir = dir;
  const cutoff = now - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const kept: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const path = join(dir, name);
    try {
      const info = statSync(path);
      if (info.mtimeMs < cutoff) {
        unlinkSync(path);
        continue;
      }
      kept.push({ path, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // 删不掉不影响写入
    }
  }
  let total = kept.reduce((sum, file) => sum + file.size, 0);
  if (total <= MAX_TOTAL_BYTES) return;
  kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of kept) {
    if (total <= MAX_TOTAL_BYTES) break;
    try {
      unlinkSync(file.path);
      total -= file.size;
    } catch {
      // 同上
    }
  }
}

function writeNow(): void {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  const now = Date.now();
  // 按 scope 分组，避免一行写一个文件（缩小 fsync 次数）
  const byScope = new Map<string, LogEntry[]>();
  for (const entry of batch) {
    const list = byScope.get(entry.scope) || [];
    list.push(entry);
    byScope.set(entry.scope, list);
  }
  for (const [scope, entries] of byScope) {
    const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
    try {
      appendFileSync(fileFor(scope, now), `${body}\n`);
    } catch {
      dropped += entries.length;
    }
  }
  prune(now);
}

function schedule(): void {
  if (flushTimer) return;
  flushTimer = setInterval(writeNow, FLUSH_MS);
  // 不要因为这个定时器让进程无法退出
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

function record(level: LogLevel, scope: string, event: string, fields?: Record<string, unknown>): void {
  if ((LEVELS[level] ?? 0) < threshold) return;
  const entry: LogEntry = { at: Date.now(), level, scope, event, ...fields };
  queue.push(entry);
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  schedule();
  if (queue.length >= FLUSH_BATCH) writeNow();
}

function errorFields(error: unknown): Record<string, unknown> {
  if (!error) return {};
  const value = error as { message?: unknown; code?: unknown; stack?: unknown };
  return {
    message: String(value.message || error),
    code: value.code,
    stack: typeof value.stack === 'string' ? value.stack.split('\n').slice(0, 6).join('\n') : undefined,
  };
}

/**
 * 调整落盘级别。宿主按自己的形态选一个：常驻进程留 info（内存采样要落盘），
 * 一次性命令（`mica exec`、插件命令）只留 warn 以上，避免每次调用都建一个文件。
 */
export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level] ?? threshold;
}

export function logger(scope: string): Logger {
  const log = (level: LogLevel) => (event: string, fields?: Record<string, unknown>) =>
    record(level, scope, event, fields);
  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: (event: string, fields: Record<string, unknown> = {}) =>
      record('error', scope, event, { ...errorFields(fields.error), ...fields, error: undefined }),
    /** 执行并计时；超阈值记 slow。返回 fn 的结果，异常照常抛出并记录。 */
    async timed<T>(event: string, fn: () => Promise<T>, limit = SLOW_MS): Promise<T> {
      const started = Date.now();
      try {
        const result = await fn();
        noteSlow(scope, event, Date.now() - started, limit, true);
        return result;
      } catch (error) {
        const ms = Date.now() - started;
        noteSlow(scope, event, ms, limit, false);
        record('error', scope, event, { ms, ...errorFields(error) });
        throw error;
      }
    },

    /**
     * 调用本身成功、但把失败包在返回值里（`{ ok: false, error }` / `{ error }`）的通道
     * 用这个：否则日志里只有一条慢调用，看不出它到底是超时、被取消还是真的报错。
     * 只抄回一条短消息，不记录 payload。
     */
    async timedResult<T>(event: string, fn: () => Promise<T>, limit = SLOW_MS): Promise<T> {
      const started = Date.now();
      let result: T;
      try {
        result = await fn();
      } catch (error) {
        const ms = Date.now() - started;
        noteSlow(scope, event, ms, limit, false);
        record('error', scope, event, { ms, ...errorFields(error) });
        throw error;
      }
      const ms = Date.now() - started;
      const failure = resultFailure(result);
      noteSlow(scope, event, ms, limit, !failure);
      if (failure) record('warn', scope, event, { ms, kind: 'failed', error: failure });
      return result;
    },
  };
}

/** 从 `{ ok:false, error }` / `{ error }` 这类返回体里取出失败原因（没有就返回 null）。 */
function resultFailure(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const value = result as { ok?: unknown; error?: unknown };
  if (value.ok !== false && !value.error) return null;
  const message =
    typeof value.error === 'string'
      ? value.error
      : (value.error as { message?: unknown } | null | undefined)?.message;
  return String(message || 'unknown error').slice(0, 200);
}

function noteSlow(scope: string, event: string, ms: number, limit: number, ok: boolean): void {
  const key = `${scope}:${event}`;
  const stat = slowStats.get(key) || { count: 0, totalMs: 0, maxMs: 0, slow: 0, fails: 0 };
  stat.count += 1;
  stat.totalMs += ms;
  stat.maxMs = Math.max(stat.maxMs, ms);
  if (!ok) stat.fails += 1;
  if (ms >= limit) {
    stat.slow += 1;
    // 慢调用单独记一条 warn：这是「卡在哪」最直接的线索。
    record('warn', scope, event, { ms, kind: 'slow' });
  } else if (ok) {
    // 常态调用也记，否则 Performance 面板看不到各功能的基线耗时。
    // 用 kind:'call' 与应用事件区分，页面的事件流不展示它们（耗时时看聚合表）。
    record('info', scope, event, { ms, kind: 'call' });
  }
  slowStats.set(key, stat);
}

const MB = 1024 * 1024;
const toMB = (bytes: number): number => Math.round((bytes / MB) * 10) / 10;

/** 当前进程的内存快照（MB）。额外字段（会话 id、子进程数…）由调用方补充。 */
export function collectMemory(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const mem = process.memoryUsage();
  return {
    rss: toMB(mem.rss),
    heap: toMB(mem.heapUsed),
    heapT: toMB(mem.heapTotal),
    ext: toMB(mem.external),
    ab: toMB(mem.arrayBuffers),
    pid: process.pid,
    ...extra,
  };
}

export interface MemorySamplerOptions {
  /** 进程身份（`runtime` / `main` / `app-server` / `tui`），Performance 页按它分组。 */
  host: string;
  intervalMs?: number;
  /** 每次采样时补充的现场（会话 id、子进程数、当前会话文件大小…）。抛错不影响采样。 */
  describe?: () => Record<string, unknown> | null | undefined;
  /** 立刻采一条（默认 true），否则第一份数据要等一个间隔。 */
  immediate?: boolean;
}

/**
 * 周期性把本进程内存写进诊断日志。返回停止函数：进程退出、长任务结束时要调用，
 * 否则测试或一次性宿主会被这个定时器拖着（已 unref，但仍会多写几行）。
 */
export function startMemorySampler(options: MemorySamplerOptions): () => void {
  const intervalMs = Math.max(5_000, Math.floor(Number(options.intervalMs) || MEM_INTERVAL_MS));
  const log = logger('mem');
  const tick = (): void => {
    let extra: Record<string, unknown> = {};
    if (options.describe) {
      try {
        extra = options.describe() || {};
      } catch (error) {
        extra = { describeError: String((error as Error)?.message || error).slice(0, 120) };
      }
    }
    try {
      log.info('sample', { host: options.host, ...collectMemory(extra) });
    } catch {
      // 采样失败绝不能影响宿主
    }
  };
  if (options.immediate !== false) tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

/** 最近的内存事件（含未落盘的），供 diagnostics:snapshot 使用。 */
export function snapshot(limit = 200): LogEntry[] {
  return ring.slice(-limit).map((entry) => ({ ...entry }));
}

/** 按「平均耗时」排序的调用统计，直接回答「哪个功能慢」。 */
export function slowReport(limit = 30): Array<{
  key: string;
  count: number;
  fails: number;
  slow: number;
  avgMs: number;
  maxMs: number;
}> {
  return [...slowStats.entries()]
    .map(([key, stat]) => ({
      key,
      count: stat.count,
      fails: stat.fails,
      slow: stat.slow,
      avgMs: Math.round(stat.totalMs / Math.max(1, stat.count)),
      maxMs: stat.maxMs,
    }))
    .sort((a, b) => b.avgMs * b.count - a.avgMs * a.count)
    .slice(0, limit);
}

export function stats(): {
  queued: number;
  ring: number;
  dropped: number;
  slowKeys: number;
  threshold: number;
  dir: string;
} {
  return {
    queued: queue.length,
    ring: ring.length,
    dropped,
    slowKeys: slowStats.size,
    threshold,
    dir: logDir(),
  };
}

/**
 * 读日志文件并聚合，供配置页的 Performance 面板使用。
 *
 * 只读最近 `maxBytes` 字节（从尾部取），避免一个 16MB 的文件把页面拖死；
 * 聚合在宿主做完再交出去，页面只负责渲染。
 */
export function readPerformanceSummary(options: Record<string, unknown> = {}): PerfMetrics {
  const dir = logDir();
  const num = (value: unknown, fallback: number): number => Number(value) || fallback;
  const maxBytes = Math.min(num(options.maxBytes, 4 * 1024 * 1024), 16 * 1024 * 1024);
  const eventLimit = Math.min(num(options.limit, 300), 2000);
  const bucketLimit = Math.min(num(options.buckets, 40), 200);
  const timelineLimit = Math.min(num(options.timeline, 300), 2000);

  let names: Array<{ name: string; path: string; bytes: number; modifiedAt: number }> = [];
  try {
    names = readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => {
        const path = join(dir, name);
        try {
          const info = statSync(path);
          return { name, path, bytes: info.size, modifiedAt: info.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((item): item is { name: string; path: string; bytes: number; modifiedAt: number } => item !== null)
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .slice(0, 20);
  } catch {
    return emptySummary(dir);
  }

  const files = names.map(({ name, bytes, modifiedAt }) => ({ name, bytes, modifiedAt }));
  const entries: LogEntry[] = [];
  let budget = maxBytes;
  // 新的文件优先，直到预算用完
  for (const file of names) {
    if (budget <= 0) break;
    try {
      const raw = readFileSync(file.path, 'utf8');
      const text = raw.length > budget ? raw.slice(raw.length - budget) : raw;
      budget -= text.length;
      // 截断后第一行可能不完整，丢掉
      for (const line of text.split('\n')) {
        if (!line) continue;
        try {
          entries.push(JSON.parse(line) as LogEntry);
        } catch {
          // 半行 / 非法行跳过
        }
      }
    } catch {
      // 读不了就跳过这个文件
    }
  }
  entries.sort((a, b) => (a.at || 0) - (b.at || 0));

  const buckets = new Map<string, { scope: string; event: string; count: number; slow: number; fails: number; totalMs: number; maxMs: number }>();
  const timeline: PerfTimelinePoint[] = [];
  const memory: PerfMemoryPoint[] = [];
  const processes = new Map<string, PerfMemoryProcess>();
  let errors = 0;
  let warns = 0;
  let slowCalls = 0;
  let samples = 0;
  let hiddenSamples = 0;
  let memSamples = 0;
  let peakRssMB = 0;
  let first = 0;
  let last = 0;

  for (const entry of entries) {
    const at = entry.at || 0;
    if (at) {
      if (!first) first = at;
      last = at;
    }
    if (entry.level === 'error') errors += 1;
    if (entry.level === 'warn') warns += 1;

    // 渲染层采样点单独抽成时间线
    if (entry.scope === 'perf' && entry.event === 'sample') {
      // 隐藏窗口的采样没有 lag（定时器被节流，算出来全是假冻结），只留 DOM/堆，
      // 别让 Number(null) || 0 把它们混进「流畅」的那一档。
      if (entry.vis !== 1 || typeof entry.lag !== 'number') {
        hiddenSamples += 1;
        continue;
      }
      samples += 1;
      timeline.push({
        at,
        lag: Number(entry.lag) || 0,
        long: Number(entry.long) || 0,
        longN: Number(entry.longN) || 0,
        dom: Number(entry.dom) || 0,
        heapMB: typeof entry.heapMB === 'number' ? entry.heapMB : undefined,
        rows: typeof entry.rows === 'number' ? entry.rows : undefined,
        sid: typeof entry.sid === 'string' ? entry.sid : undefined,
      });
      continue;
    }

    // 进程内存采样单独一条线（`startMemorySampler`），不进耗时聚合
    if (entry.scope === 'mem' && entry.event === 'sample') {
      const rssMB = Number(entry.rss) || 0;
      const pid = Number(entry.pid) || 0;
      const host = typeof entry.host === 'string' ? entry.host : 'unknown';
      const session = typeof entry.session === 'string' ? entry.session : undefined;
      memSamples += 1;
      peakRssMB = Math.max(peakRssMB, rssMB);
      memory.push({
        at,
        rssMB,
        heapMB: Number(entry.heap) || 0,
        externalMB: Number(entry.ext) || 0,
        pid,
        host,
      });
      const key = `${host}#${pid}`;
      const known = processes.get(key);
      if (!known) {
        processes.set(key, {
          key,
          host,
          pid,
          session,
          samples: 1,
          lastRssMB: rssMB,
          peakRssMB: rssMB,
          firstRssMB: rssMB,
          lastHeapMB: Number(entry.heap) || 0,
          lastExternalMB: Number(entry.ext) || 0,
          growthMB: 0,
        });
      } else {
        known.samples += 1;
        known.lastRssMB = rssMB;
        known.peakRssMB = Math.max(known.peakRssMB, rssMB);
        known.lastHeapMB = Number(entry.heap) || 0;
        known.lastExternalMB = Number(entry.ext) || 0;
        if (session) known.session = session;
        known.growthMB = Math.round((known.lastRssMB - known.firstRssMB) * 10) / 10;
      }
      continue;
    }

    if (typeof entry.ms === 'number' && entry.scope !== 'perf') {
      const key = `${entry.scope}:${entry.event}`;
      const bucket = buckets.get(key) || {
        scope: entry.scope,
        event: entry.event,
        count: 0,
        slow: 0,
        fails: 0,
        totalMs: 0,
        maxMs: 0,
      };
      bucket.count += 1;
      bucket.totalMs += entry.ms;
      bucket.maxMs = Math.max(bucket.maxMs, entry.ms);
      if (entry.level === 'warn' && entry.kind === 'slow') {
        bucket.slow += 1;
        slowCalls += 1;
      }
      // `kind:'failed'` 是「调用成功返回、但返回体里带着错误」的那些（见 timedResult）。
      if (entry.level === 'error' || entry.kind === 'failed') bucket.fails += 1;
      buckets.set(key, bucket);
    }
  }

  return {
    available: true,
    dir,
    files,
    totals: {
      events: entries.length,
      errors,
      warns,
      slowCalls,
      samples,
      hiddenSamples,
      spanMs: first && last ? last - first : 0,
      memSamples,
      peakRssMB,
    },
    pending: queue.length,
    buckets: [...buckets.values()]
      .map((bucket) => ({
        scope: bucket.scope,
        event: bucket.event,
        count: bucket.count,
        slow: bucket.slow,
        fails: bucket.fails,
        avgMs: Math.round(bucket.totalMs / Math.max(1, bucket.count)),
        maxMs: Math.round(bucket.maxMs),
      }))
      .sort((a, b) => b.avgMs * b.count - a.avgMs * a.count)
      .slice(0, bucketLimit),
    timeline: timeline.slice(-timelineLimit),
    memory: memory.slice(-timelineLimit),
    processes: [...processes.values()]
      // 只剩最后一次采样的进程（已退出）没有趋势可看，但仍要留在表里：
      // 一个 1.2GB 的宿主挂在那儿，正是最需要被看见的东西。
      .map((item) => ({ ...item, growthMB: Math.round((item.lastRssMB - item.firstRssMB) * 10) / 10 }))
      .sort((a, b) => b.lastRssMB - a.lastRssMB),
    events: entries
      // kind:'call' 是常态调用的耗时记录，已由聚合表呈现，事件流里不重复刷屏。
      // 内存采样也已单独成一条线，同样不混进事件流。
      .filter((entry) => entry.level !== 'debug' && entry.kind !== 'call' && entry.scope !== 'mem')
      .slice(-eventLimit)
      .reverse()
      .map((entry) => ({
        at: entry.at || 0,
        level: entry.level || 'info',
        scope: entry.scope || 'unknown',
        event: entry.event || '',
        ms: entry.ms as number | undefined,
        lag: entry.lag as number | null | undefined,
        long: entry.long as number | undefined,
        longN: entry.longN as number | undefined,
        dom: entry.dom as number | undefined,
        rows: entry.rows as number | undefined,
        heapMB: entry.heapMB as number | undefined,
        vis: entry.vis as number | undefined,
        count: entry.count as number | undefined,
        error: entry.message || entry.error,
        sid: entry.sid as string | undefined,
        rssMB: entry.rss as number | undefined,
      })),
  };
}

function emptySummary(dir: string): PerfMetrics {
  return {
    available: true,
    dir,
    files: [],
    totals: {
      events: 0,
      errors: 0,
      warns: 0,
      slowCalls: 0,
      samples: 0,
      hiddenSamples: 0,
      spanMs: 0,
      memSamples: 0,
      peakRssMB: 0,
    },
    pending: queue.length,
    buckets: [],
    timeline: [],
    memory: [],
    processes: [],
    events: [],
  };
}

/** 清空当前日志目录（配置页上的「清空」按钮）。 */
export function clearLogs(): { removed: number } {
  writeNow();
  const dir = logDir();
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return { removed: 0 };
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    try {
      unlinkSync(join(dir, name));
      removed += 1;
    } catch {
      // 删不掉就留着
    }
  }
  ring = [];
  slowStats = new Map();
  dropped = 0;
  return { removed };
}

/** 退出前把剩余事件写完。 */
export function flushLogs(): void {
  writeNow();
}
