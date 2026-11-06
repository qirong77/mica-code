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
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLogDir } from '@packages/mica-config/brand.js';
import { clearPerformanceCache, readSummary, readSummaryAsync } from './performance-summary.js';

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
  timed<T>(event: string, fn: () => Promise<T>, threshold?: number, meta?: Record<string, unknown>): Promise<T>;
  timedResult<T>(
    event: string,
    fn: () => Promise<T>,
    threshold?: number,
    meta?: Record<string, unknown>,
  ): Promise<T>;
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
  pageId?: string;
}

export interface PerfMemoryPoint {
  at: number;
  rssMB: number;
  /** Bun/JSC 不上报（那套 heap 数字不可信），只有 Node/V8 进程有。 */
  heapMB?: number;
  externalMB?: number;
  pid: number;
  host: string;
}

export interface PerfMemoryProcess {
  key: string;
  host: string;
  pid: number;
  session?: string;
  samples: number;
  /** 最后一次采样的时刻。退出后的进程仍留在表里（那正是最该被看见的），靠它区分。 */
  lastAt: number;
  lastRssMB: number;
  peakRssMB: number;
  firstRssMB: number;
  lastHeapMB?: number;
  lastExternalMB?: number;
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
  /** 调用方归因（`logger.timedResult` 的 meta）：哪个插件、是否来自隐藏页面。 */
  plugin?: string;
  hidden?: boolean;
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

function safeScope(scope: string): string {
  const cleaned = String(scope || 'app')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (cleaned || 'app').slice(0, 32);
}

function fileFor(scope: string, now: number): string {
  const dir = logDir();
  // scope 会拼进文件名，而它可能来自渲染层或插件（`log:report`）：只放行文件名安全的字符，
  // 否则 `../../x` 能把日志写到目录外。
  const key = `${safeScope(scope)}-${dayStamp(now)}`;
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
    try {
      // stringify 也放进 try：字段里出现 BigInt / 循环引用时不能把异常抛回调用方
      // （队列满 100 条时 record() 会同步走到这里）。
      const body = entries.map((entry) => JSON.stringify(entry)).join('\n');
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
    /**
     * 执行并计时；超阈值记 slow。返回 fn 的结果，异常照常抛出并记录。
     *
     * `meta` 是调用方现场（哪个插件、哪条会话、哪个工作目录）：同一个通道可能被十几个
     * 调用方打，只按通道名聚合回答不了「这 600 次是谁发的」。它只进事件行，不进
     * `slowReport()` 的聚合键，避免聚合表被高基数键撑开。
     */
    async timed<T>(event: string, fn: () => Promise<T>, limit = SLOW_MS, meta?: Record<string, unknown>): Promise<T> {
      const started = Date.now();
      try {
        const result = await fn();
        noteSlow(scope, event, Date.now() - started, limit, true, undefined, meta);
        return result;
      } catch (error) {
        const ms = Date.now() - started;
        noteSlow(scope, event, ms, limit, false, { level: 'error', fields: errorFields(error) }, meta);
        throw error;
      }
    },

    /**
     * 调用本身成功、但把失败包在返回值里（`{ ok: false, error }` / `{ error }`）的通道
     * 用这个：否则日志里只有一条慢调用，看不出它到底是超时、被取消还是真的报错。
     * 只抄回一条短消息，不记录 payload。
     */
    async timedResult<T>(
      event: string,
      fn: () => Promise<T>,
      limit = SLOW_MS,
      meta?: Record<string, unknown>,
    ): Promise<T> {
      const started = Date.now();
      let result: T;
      try {
        result = await fn();
      } catch (error) {
        const ms = Date.now() - started;
        noteSlow(scope, event, ms, limit, false, { level: 'error', fields: errorFields(error) }, meta);
        throw error;
      }
      const ms = Date.now() - started;
      const failure = resultFailure(result);
      noteSlow(
        scope,
        event,
        ms,
        limit,
        !failure,
        failure ? { level: 'warn', fields: { error: failure } } : undefined,
        meta,
      );
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
    typeof value.error === 'string' ? value.error : (value.error as { message?: unknown } | null | undefined)?.message;
  return String(message || 'unknown error').slice(0, 200);
}

function noteSlow(
  scope: string,
  event: string,
  ms: number,
  limit: number,
  ok: boolean,
  failure?: { level: 'warn' | 'error'; fields: Record<string, unknown> },
  meta?: Record<string, unknown>,
): void {
  const key = `${scope}:${event}`;
  const stat = slowStats.get(key) || { count: 0, totalMs: 0, maxMs: 0, slow: 0, fails: 0 };
  stat.count += 1;
  stat.totalMs += ms;
  stat.maxMs = Math.max(stat.maxMs, ms);
  if (!ok) stat.fails += 1;
  // 调用方现场只跟在事件行上；`undefined` 值不落盘（否则每行都是 `pluginId: null`）。
  const who: Record<string, unknown> = {};
  if (meta) {
    for (const [name, value] of Object.entries(meta)) {
      if (value !== undefined && value !== null && value !== '') who[name] = value;
    }
  }
  if (ms >= limit) {
    stat.slow += 1;
    // 慢调用单独记一条 warn：这是「卡在哪」最直接的线索。
    record(failure?.level || 'warn', scope, event, {
      ms,
      kind: 'slow',
      ...who,
      ...(failure ? { failed: true, ...failure.fields } : {}),
    });
  } else if (failure) {
    record(failure.level, scope, event, { ms, kind: 'failed', ...who, ...failure.fields });
  } else if (ok) {
    // 常态调用也记，否则 Performance 面板看不到各功能的基线耗时。
    // 用 kind:'call' 与应用事件区分，页面的事件流不展示它们（耗时时看聚合表）。
    record('info', scope, event, { ms, kind: 'call', ...who });
  }
  slowStats.set(key, stat);
}

const MB = 1024 * 1024;
const toMB = (bytes: number): number => Math.round((bytes / MB) * 10) / 10;

/**
 * 当前进程的内存快照（MB）。额外字段（会话 id、子进程数…）由调用方补充。
 *
 * Bun（JSC）下 `process.memoryUsage()` 的 heap / external / arrayBuffers 三项不可信：
 * 实测 `heapUsed 524MB > heapTotal 374MB`，日志里还出现过 `heap 5014MB / heapT 161MB`、
 * `rss 95MB / ext 430MB` 这种不可能的组合。写进去会让任何按日志判断内存的人得出错误
 * 结论（第一版排查就被它带偏过），所以 Bun 下只留 RSS，并显式标 `heapReliable: false`。
 * 判断「谁在涨」用 RSS；要看 JS 堆得去 CPU profile / heap snapshot。
 */
export function collectMemory(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const mem = process.memoryUsage();
  const bun = Boolean(process.versions.bun);
  return {
    rss: toMB(mem.rss),
    ...(bun
      ? { heapReliable: false }
      : {
          heap: toMB(mem.heapUsed),
          heapT: toMB(mem.heapTotal),
          ext: toMB(mem.external),
          ab: toMB(mem.arrayBuffers),
        }),
    pid: process.pid,
    runtime: bun ? 'bun' : 'node',
    engine: bun ? 'jsc' : 'v8',
    ...extra,
  };
}

/**
 * 内存尖峰阈值：RSS 越过它就从 info 升成一条 warn，并带上 `describe()` 的现场。
 *
 * 采样每 30s 一条，一个回合把宿主顶到 2GB 再还回去只会在日志里留下两三个点，
 * 事后翻的时候看不出「那一刻在跑什么」。越阈值时单独记一条，把现场固定下来。
 */
const spikeRssMb = (override?: number): number => {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) return override;
  const configured = Number(process.env.MICA_LOG_SPIKE_MB);
  return Number.isFinite(configured) && configured > 0 ? configured : 1024;
};
// 掉回阈值以下之后要隔这么久才允许再报一次，否则在阈值上下抖动时会连续刷屏。
const SPIKE_COOLDOWN_MS = 10 * 60 * 1000;

export interface MemorySamplerOptions {
  /** 进程身份（`runtime` / `main` / `app-server` / `tui`），Performance 页按它分组。 */
  host: string;
  intervalMs?: number;
  /** 每次采样时补充的现场（会话 id、子进程数、当前会话文件大小…）。抛错不影响采样。 */
  describe?: () => Record<string, unknown> | null | undefined;
  /** 立刻采一条（默认 true），否则第一份数据要等一个间隔。 */
  immediate?: boolean;
  /** 内存尖峰阈值（MB），默认取 `MICA_LOG_SPIKE_MB`，再不行 1024。 */
  spikeRssMB?: number;
}

/**
 * 周期性把本进程内存写进诊断日志。返回停止函数：进程退出、长任务结束时要调用，
 * 否则测试或一次性宿主会被这个定时器拖着（已 unref，但仍会多写几行）。
 */
export function startMemorySampler(options: MemorySamplerOptions): () => void {
  const intervalMs = Math.max(5_000, Math.floor(Number(options.intervalMs) || MEM_INTERVAL_MS));
  const log = logger('mem');
  const spikeLimit = spikeRssMb(options.spikeRssMB);
  let spiking = false;
  let lastSpikeAt = 0;
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
      const memory = collectMemory(extra);
      log.info('sample', { host: options.host, ...memory });
      // 尖峰只在「刚越过阈值、且过了冷却」时报一次：持续处于高位不该每 30 秒刷一条。
      const rss = Number(memory.rss) || 0;
      if (rss >= spikeLimit) {
        if (!spiking && Date.now() - lastSpikeAt >= SPIKE_COOLDOWN_MS) {
          lastSpikeAt = Date.now();
          log.warn('spike', { host: options.host, ...memory });
        }
        spiking = true;
      } else {
        spiking = false;
      }
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

/** 同步诊断入口；文件未变化时复用有界的精简聚合缓存。 */
export function readPerformanceSummary(options: Record<string, unknown> = {}): PerfMetrics {
  return { ...readSummary(options), pending: queue.length };
}

/** 生产刷新入口：异步分块读盘与解析，同参数的并发刷新合并成一次读取。 */
export async function readPerformanceSummaryAsync(options: Record<string, unknown> = {}): Promise<PerfMetrics> {
  return { ...(await readSummaryAsync(options)), pending: queue.length };
}

/** 清空当前日志目录（配置页上的「清空」按钮）。 */
export function clearLogs(): { removed: number } {
  clearPerformanceCache();
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
