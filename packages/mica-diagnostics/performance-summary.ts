import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveLogDir } from '@packages/mica-config/brand.js';
import type {
  LogEntry,
  PerfBucket,
  PerfEvent,
  PerfMemoryPoint,
  PerfMemoryProcess,
  PerfMetrics,
  PerfTimelinePoint,
} from './index.js';

// 缓存只留计数、进程投影和限量的显示项，不持有原始 JSON / payload / 读盘 buffer。
// 容量按保守的投影大小估算，另限文件数；高基数文件超预算时仍可读取，但不常驻。
const CACHE_BYTES = 32 * 1024 * 1024;
const CACHE_FILES = 256;
const SUMMARY_BYTES = 2 * 1024 * 1024;
const READ_BYTES = 64 * 1024;
const MERGE_BATCH = 256;
const ERROR_CHARS = 2000;

type Limits = { maxBytes: number; events: number; buckets: number; timeline: number };
type FileInfo = {
  name: string;
  path: string;
  bytes: number;
  modifiedAt: number;
  changedAt: number;
  dev: number;
  ino: number;
};
type FileWindow = { file: FileInfo; bytes: number };
type Ordered<T> = { at: number; order: number; value: T };
type Bucket = Omit<PerfBucket, 'avgMs'> & { totalMs: number; firstAt: number; firstOrder: number };
type MemoryProcess = PerfMemoryProcess & {
  firstAt: number;
  firstOrder: number;
  lastOrder: number;
  sessionAt: number;
  sessionOrder: number;
};

/** 小顶堆只留时间上最新的 N 项，日志乱序 / 相同采样时刻也不需要全量排序。 */
class Recent<T> {
  items: Array<Ordered<T>> = [];

  constructor(private limit: number) {}

  add(item: Ordered<T>): void {
    if (!this.limit) return;
    const items = this.items;
    if (items.length < this.limit) {
      items.push(item);
      let i = items.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (compare(items[parent]!, item) <= 0) break;
        items[i] = items[parent]!;
        i = parent;
      }
      items[i] = item;
    } else if (compare(item, items[0]!) > 0) {
      let i = 0;
      while (i * 2 + 1 < items.length) {
        let child = i * 2 + 1;
        if (child + 1 < items.length && compare(items[child + 1]!, items[child]!) < 0) child += 1;
        if (compare(items[child]!, item) >= 0) break;
        items[i] = items[child]!;
        i = child;
      }
      items[i] = item;
    }
  }

  values(reverse = false): T[] {
    return this.items
      .slice()
      .sort((a, b) => (reverse ? compare(b, a) : compare(a, b)))
      .map(({ value }) => ({ ...value }));
  }
}

function compare(a: { at: number; order: number }, b: { at: number; order: number }): number {
  return a.at - b.at || a.order - b.order;
}

class Aggregate {
  totals = {
    events: 0,
    errors: 0,
    warns: 0,
    slowCalls: 0,
    samples: 0,
    hiddenSamples: 0,
    spanMs: 0,
    memSamples: 0,
    peakRssMB: 0,
  };
  first = Infinity;
  last = 0;
  buckets = new Map<string, Bucket>();
  processes = new Map<string, MemoryProcess>();
  timeline: Recent<PerfTimelinePoint>;
  memory: Recent<PerfMemoryPoint>;
  events: Recent<PerfEvent>;

  constructor(limits: Limits) {
    this.timeline = new Recent(limits.timeline);
    this.memory = new Recent(limits.timeline);
    this.events = new Recent(limits.events);
  }

  add(entry: LogEntry, order: number): void {
    const at = typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0;
    const totals = this.totals;
    totals.events += 1;
    if (at) {
      this.first = Math.min(this.first, at);
      this.last = Math.max(this.last, at);
    }
    if (entry.level === 'error') totals.errors += 1;
    if (entry.level === 'warn') totals.warns += 1;

    if (entry.scope === 'perf' && entry.event === 'sample') {
      if (entry.vis !== 1 || typeof entry.lag !== 'number') totals.hiddenSamples += 1;
      else {
        totals.samples += 1;
        this.timeline.add({
          at,
          order,
          value: {
            at,
            lag: Number(entry.lag) || 0,
            long: Number(entry.long) || 0,
            longN: Number(entry.longN) || 0,
            dom: Number(entry.dom) || 0,
            heapMB: typeof entry.heapMB === 'number' ? entry.heapMB : undefined,
            rows: typeof entry.rows === 'number' ? entry.rows : undefined,
            sid: typeof entry.sid === 'string' ? entry.sid : undefined,
            pageId: typeof entry.pageId === 'string' ? entry.pageId : undefined,
          },
        });
      }
    } else if (entry.scope === 'mem' && entry.event === 'sample') {
      const rssMB = Number(entry.rss) || 0;
      const pid = Number(entry.pid) || 0;
      const host = typeof entry.host === 'string' ? entry.host : 'unknown';
      const session = typeof entry.session === 'string' && entry.session ? entry.session : undefined;
      // Bun 进程的 heap / ext 不可信，采样时就不写（见 collectMemory）。这里保持
      // 「没有就是没有」：写成 0 会让页面显示「堆 0MB」，比不显示更误导。
      const heapMB = typeof entry.heap === 'number' ? entry.heap : undefined;
      const externalMB = typeof entry.ext === 'number' ? entry.ext : undefined;
      totals.memSamples += 1;
      totals.peakRssMB = Math.max(totals.peakRssMB, rssMB);
      this.memory.add({ at, order, value: { at, rssMB, heapMB, externalMB, pid, host } });
      mergeProcess(this.processes, {
        key: `${host}#${pid}`,
        host,
        pid,
        session,
        samples: 1,
        firstAt: at,
        firstOrder: order,
        firstRssMB: rssMB,
        lastAt: at,
        lastOrder: order,
        lastRssMB: rssMB,
        peakRssMB: rssMB,
        lastHeapMB: heapMB,
        lastExternalMB: externalMB,
        growthMB: 0,
        sessionAt: session ? at : -Infinity,
        sessionOrder: order,
      });
    } else if (typeof entry.ms === 'number' && entry.scope !== 'perf') {
      const key = `${entry.scope}:${entry.event}`;
      const bucket = this.buckets.get(key) || {
        scope: entry.scope,
        event: entry.event,
        count: 0,
        slow: 0,
        fails: 0,
        totalMs: 0,
        maxMs: 0,
        firstAt: at,
        firstOrder: order,
      };
      if (compare({ at, order }, { at: bucket.firstAt, order: bucket.firstOrder }) < 0) {
        bucket.firstAt = at;
        bucket.firstOrder = order;
      }
      bucket.count += 1;
      bucket.totalMs += entry.ms;
      bucket.maxMs = Math.max(bucket.maxMs, entry.ms);
      if (entry.kind === 'slow') {
        bucket.slow += 1;
        totals.slowCalls += 1;
      }
      if (entry.level === 'error' || entry.kind === 'failed' || entry.failed === true) bucket.fails += 1;
      this.buckets.set(key, bucket);
    }

    // `mem` 的 info 采样只进内存聚合（每进程一行），但它的 warn / error（内存尖峰、
    // 采样失败）必须出现在事件流里——那正是「刚才那一下是什么」要找的东西。
    if (entry.level !== 'debug' && entry.kind !== 'call' && !(entry.scope === 'mem' && entry.level === 'info')) {
      // 仅投影页面会展示的标量；错误对象不把任意嵌套 payload 带进缓存。
      const error = entry.message || entry.error;
      this.events.add({
        at,
        order,
        value: {
          at,
          level: entry.level || 'info',
          scope: entry.scope || 'unknown',
          event: entry.event || '',
          ms: scalar(entry.ms),
          lag: entry.lag === null ? null : scalar(entry.lag),
          long: scalar(entry.long),
          longN: scalar(entry.longN),
          dom: scalar(entry.dom),
          rows: scalar(entry.rows),
          heapMB: scalar(entry.heapMB),
          vis: scalar(entry.vis),
          count: scalar(entry.count),
          error: error ? errorText(error) : undefined,
          sid: typeof entry.sid === 'string' ? entry.sid : undefined,
          rssMB: scalar(entry.rss),
          // 调用方归因（见 logger.timedResult 的 meta）。同一通道被多个调用方打时，
          // 「这 600 次是谁发的」只能靠它们回答；聚合表仍按 scope:event 一行。
          plugin: typeof entry.plugin === 'string' ? entry.plugin : undefined,
          hidden: entry.hidden === true ? true : undefined,
        },
      });
    }
  }
}

function scalar(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function errorText(error: unknown): string {
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : error;
  // 拷贝截取后的短文本，避免 V8 的 sliced string 把一整条巨大错误字符串挂在缓存里。
  return Buffer.from(String(message ?? error).slice(0, ERROR_CHARS)).toString('utf8');
}

function mergeProcess(processes: Map<string, MemoryProcess>, item: MemoryProcess): void {
  const known = processes.get(item.key);
  if (!known) {
    processes.set(item.key, { ...item });
    return;
  }
  known.samples += item.samples;
  known.peakRssMB = Math.max(known.peakRssMB, item.peakRssMB);
  if (compare({ at: item.firstAt, order: item.firstOrder }, { at: known.firstAt, order: known.firstOrder }) < 0) {
    known.firstAt = item.firstAt;
    known.firstOrder = item.firstOrder;
    known.firstRssMB = item.firstRssMB;
  }
  if (compare({ at: item.lastAt, order: item.lastOrder }, { at: known.lastAt, order: known.lastOrder }) > 0) {
    known.lastAt = item.lastAt;
    known.lastOrder = item.lastOrder;
    known.lastRssMB = item.lastRssMB;
    known.lastHeapMB = item.lastHeapMB;
    known.lastExternalMB = item.lastExternalMB;
  }
  if (
    item.session &&
    compare({ at: item.sessionAt, order: item.sessionOrder }, { at: known.sessionAt, order: known.sessionOrder }) > 0
  ) {
    known.session = item.session;
    known.sessionAt = item.sessionAt;
    known.sessionOrder = item.sessionOrder;
  }
}

class Lines {
  aggregate: Aggregate;
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private order = 0;

  constructor(
    limits: Limits,
    private skipFirst: boolean,
  ) {
    this.aggregate = new Aggregate(limits);
  }

  feed(bytes: Buffer): void {
    let start = 0;
    if (this.skipFirst) {
      start = bytes.indexOf(10) + 1;
      if (!start) return;
      this.skipFirst = false;
    }
    for (let end = bytes.indexOf(10, start); end >= 0; end = bytes.indexOf(10, start)) {
      const part = bytes.subarray(start, end);
      if (this.fragments.length) {
        this.fragments.push(part);
        this.line(Buffer.concat(this.fragments, this.fragmentBytes + part.length).toString('utf8'));
        this.fragments = [];
        this.fragmentBytes = 0;
      } else this.line(part.toString('utf8'));
      start = end + 1;
    }
    if (start < bytes.length) {
      const tail = Buffer.from(bytes.subarray(start));
      this.fragments.push(tail);
      this.fragmentBytes += tail.length;
    }
  }

  finish(): Aggregate {
    // 保持现有语义：没有换行但已经完整的最后一条 JSON 也可见；半行解析失败跳过。
    if (this.fragments.length) this.line(Buffer.concat(this.fragments, this.fragmentBytes).toString('utf8'));
    this.fragments = [];
    this.fragmentBytes = 0;
    return this.aggregate;
  }

  private line(text: string): void {
    if (!text) return;
    try {
      const entry = JSON.parse(text) as LogEntry | null;
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        // 日志可能来自插件或手工编辑；核心字段也只允许保留字符串。
        entry.scope = typeof entry.scope === 'string' ? entry.scope : 'unknown';
        entry.event = typeof entry.event === 'string' ? entry.event : '';
        entry.level = typeof entry.level === 'string' ? entry.level : 'info';
        this.aggregate.add(entry, this.order++);
      }
    } catch {
      // 非法 / 未写完的行跳过，下一次文件变化后重新读取即可。
    }
  }
}

type CachedFile = { stamp: string; aggregate: Aggregate; weight: number };
type Cache = {
  key: string;
  files: Map<string, CachedFile>;
  bytes: number;
  summary?: { stamp: string; metrics: PerfMetrics };
};
let cache: Cache | undefined;
let epoch = 0;
let inFlight: { key: string; promise: Promise<PerfMetrics> } | undefined;

export function clearPerformanceCache(): void {
  cache = undefined;
  epoch += 1;
}

function limitsFor(options: Record<string, unknown>): Limits {
  const limit = (value: unknown, fallback: number, max: number): number => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
  };
  return {
    maxBytes: limit(options.maxBytes, 4 * 1024 * 1024, 16 * 1024 * 1024),
    events: limit(options.limit, 300, 2000),
    buckets: limit(options.buckets, 40, 200),
    timeline: limit(options.timeline, 300, 2000),
  };
}

function cacheFor(dir: string, limits: Limits): Cache {
  const key = JSON.stringify([dir, limits.events, limits.timeline]);
  if (!cache || cache.key !== key) cache = { key, files: new Map(), bytes: 0 };
  return cache;
}

function fileInfo(dir: string, name: string, info: Stats): FileInfo {
  return {
    name,
    path: join(dir, name),
    bytes: info.size,
    modifiedAt: info.mtimeMs,
    changedAt: info.ctimeMs,
    dev: info.dev,
    ino: info.ino,
  };
}

function stamp(file: FileInfo): string {
  return `${file.dev}:${file.ino}:${file.bytes}:${file.modifiedAt}:${file.changedAt}`;
}

function windowsFor(names: FileInfo[], limits: Limits, store: Cache): FileWindow[] {
  names.sort((a, b) => b.modifiedAt - a.modifiedAt || b.name.localeCompare(a.name));
  const budgets = new Map<string, number>();
  const windows: FileWindow[] = [];
  for (const file of names) {
    const scope = file.name.match(/^(.+)-\d{8}(?:-\d+)?\.jsonl$/)?.[1] || file.name;
    const budget = budgets.get(scope) ?? limits.maxBytes;
    if (budget <= 0 || file.bytes === 0) continue;
    const bytes = Math.min(budget, file.bytes);
    windows.push({ file, bytes });
    budgets.set(scope, budget - bytes);
  }
  const selected = new Set(windows.map(({ file }) => file.name));
  for (const [name, item] of store.files) {
    if (!selected.has(name)) {
      store.files.delete(name);
      store.bytes -= item.weight;
    }
  }
  return windows;
}

function cached(store: Cache, window: FileWindow): Aggregate | undefined {
  const item = store.files.get(window.file.name);
  if (!item) return;
  store.files.delete(window.file.name);
  if (item.stamp === `${stamp(window.file)}:${window.bytes}`) {
    store.files.set(window.file.name, item);
    return item.aggregate;
  }
  store.bytes -= item.weight;
}

const stringBytes = (values: object): number =>
  Object.values(values).reduce<number>((sum, value) => sum + (typeof value === 'string' ? value.length * 2 : 0), 0);

function retain(store: Cache, window: FileWindow, aggregate: Aggregate): void {
  let weight = 0;
  for (const bucket of aggregate.buckets.values()) weight += 512 + stringBytes(bucket);
  for (const item of aggregate.processes.values()) weight += 768 + stringBytes(item);
  for (const recent of [aggregate.timeline, aggregate.memory, aggregate.events]) {
    for (const item of recent.items) weight += 512 + stringBytes(item.value);
  }
  // 不缓存超预算投影，也不因此挤掉已经缓存的小文件。
  if (weight > CACHE_BYTES) return;
  const prior = store.files.get(window.file.name);
  if (prior) {
    store.files.delete(window.file.name);
    store.bytes -= prior.weight;
  }
  while (store.files.size >= CACHE_FILES || store.bytes + weight > CACHE_BYTES) {
    const name = store.files.keys().next().value;
    if (name === undefined) break;
    store.bytes -= store.files.get(name)!.weight;
    store.files.delete(name);
  }
  store.files.set(window.file.name, { stamp: `${stamp(window.file)}:${window.bytes}`, aggregate, weight });
  store.bytes += weight;
}

function summaryStamp(names: FileInfo[], limits: Limits): string {
  return JSON.stringify([limits, names.map((file) => [file.name, stamp(file)])]);
}

function copySummary(metrics: PerfMetrics): PerfMetrics {
  return {
    ...metrics,
    totals: { ...metrics.totals },
    files: metrics.files.map((item) => ({ ...item })),
    buckets: metrics.buckets.map((item) => ({ ...item })),
    timeline: metrics.timeline.map((item) => ({ ...item })),
    memory: metrics.memory.map((item) => ({ ...item })),
    processes: metrics.processes.map((item) => ({ ...item })),
    events: metrics.events.map((item) => ({ ...item })),
  };
}

function retainSummary(store: Cache, stamp: string, metrics: PerfMetrics): void {
  let weight = stamp.length * 2;
  for (const items of [
    metrics.files,
    metrics.buckets,
    metrics.timeline,
    metrics.memory,
    metrics.processes,
    metrics.events,
  ]) {
    for (const item of items) weight += 768 + stringBytes(item);
  }
  // 小结果另留一份，目录完全不变时连投影合并也省掉；文件数超上限时也不会扫描式抖动。
  store.summary = weight <= SUMMARY_BYTES ? { stamp, metrics: copySummary(metrics) } : undefined;
}

function* summary(
  dir: string,
  names: FileInfo[],
  aggregates: Aggregate[],
  limits: Limits,
): Generator<void, PerfMetrics> {
  const merged = new Aggregate(limits);
  // order 的高位对应原来的文件遍历次序，低位对应行序；时间相同时维持稳定顺序。
  let batch = 0;
  for (let i = 0; i < aggregates.length; i += 1) {
    const aggregate = aggregates[i]!;
    const orderBase = i * 2 ** 32;
    for (const key of Object.keys(merged.totals) as Array<keyof PerfMetrics['totals']>) {
      if (key === 'peakRssMB') merged.totals[key] = Math.max(merged.totals[key], aggregate.totals[key]);
      else merged.totals[key] += aggregate.totals[key];
    }
    merged.first = Math.min(merged.first, aggregate.first);
    merged.last = Math.max(merged.last, aggregate.last);
    for (const [key, bucket] of aggregate.buckets) {
      const known = merged.buckets.get(key);
      const firstOrder = orderBase + bucket.firstOrder;
      if (!known) merged.buckets.set(key, { ...bucket, firstOrder });
      else {
        known.count += bucket.count;
        known.slow += bucket.slow;
        known.fails += bucket.fails;
        known.totalMs += bucket.totalMs;
        known.maxMs = Math.max(known.maxMs, bucket.maxMs);
        if (compare({ at: bucket.firstAt, order: firstOrder }, { at: known.firstAt, order: known.firstOrder }) < 0) {
          known.firstAt = bucket.firstAt;
          known.firstOrder = firstOrder;
        }
      }
      if (++batch % MERGE_BATCH === 0) yield;
    }
    for (const item of aggregate.processes.values()) {
      mergeProcess(merged.processes, {
        ...item,
        firstOrder: orderBase + item.firstOrder,
        lastOrder: orderBase + item.lastOrder,
        sessionOrder: orderBase + item.sessionOrder,
      });
      if (++batch % MERGE_BATCH === 0) yield;
    }
    for (const key of ['timeline', 'memory', 'events'] as const) {
      // 三种 Recent 的 value 不互换；联合类型的泛型在这里用共有的 at 投影。
      const recent = merged[key] as Recent<{ at: number }>;
      for (const item of aggregate[key].items) {
        recent.add({ ...item, order: orderBase + item.order });
        if (++batch % MERGE_BATCH === 0) yield;
      }
    }
  }
  merged.totals.spanMs = Number.isFinite(merged.first) && merged.last ? merged.last - merged.first : 0;
  return {
    available: true,
    dir,
    files: names.slice(0, 20).map(({ name, bytes, modifiedAt }) => ({ name, bytes, modifiedAt })),
    totals: merged.totals,
    pending: 0,
    buckets: [...merged.buckets.values()]
      .sort(
        (a, b) =>
          Math.round(b.totalMs / Math.max(1, b.count)) * b.count -
            Math.round(a.totalMs / Math.max(1, a.count)) * a.count ||
          compare({ at: a.firstAt, order: a.firstOrder }, { at: b.firstAt, order: b.firstOrder }),
      )
      .slice(0, limits.buckets)
      .map((bucket) => ({
        scope: bucket.scope,
        event: bucket.event,
        count: bucket.count,
        slow: bucket.slow,
        fails: bucket.fails,
        avgMs: Math.round(bucket.totalMs / Math.max(1, bucket.count)),
        maxMs: Math.round(bucket.maxMs),
      })),
    timeline: merged.timeline.values(),
    memory: merged.memory.values(),
    processes: [...merged.processes.values()]
      .sort(
        (a, b) =>
          b.lastRssMB - a.lastRssMB ||
          compare({ at: a.firstAt, order: a.firstOrder }, { at: b.firstAt, order: b.firstOrder }),
      )
      .map(({ firstAt, firstOrder, lastOrder, sessionAt, sessionOrder, ...item }) => ({
        ...item,
        growthMB: Math.round((item.lastRssMB - item.firstRssMB) * 10) / 10,
      })),
    events: merged.events.values(true),
  };
}

export function readSummary(options: Record<string, unknown>): PerfMetrics {
  const dir = resolveLogDir();
  const limits = limitsFor(options);
  const store = cacheFor(dir, limits);
  const names: FileInfo[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      try {
        const info = statSync(join(dir, name));
        if (info.isFile()) names.push(fileInfo(dir, name, info));
      } catch {
        /* 文件可能刚被轮转 / 清理 */
      }
    }
  } catch {
    /* 尚未创建日志目录 */
  }
  const windows = windowsFor(names, limits, store);
  const key = summaryStamp(names, limits);
  if (store.summary?.stamp === key) return copySummary(store.summary.metrics);
  const aggregates: Aggregate[] = [];
  let stable = true;
  // 先取出已有命中，再放入新项；超过缓存容量时不提前逐出本轮后面的命中。
  const hits = windows.map((window) => cached(store, window));
  const buffer = Buffer.alloc(READ_BYTES);
  for (const [i, window] of windows.entries()) {
    const hit = hits[i];
    if (hit) {
      aggregates.push(hit);
      continue;
    }
    let fd: number | undefined;
    try {
      fd = openSync(window.file.path, 'r');
      const lines = new Lines(limits, window.file.bytes > window.bytes);
      let read = 0;
      while (read < window.bytes) {
        const n = readSync(
          fd,
          buffer,
          0,
          Math.min(buffer.length, window.bytes - read),
          window.file.bytes - window.bytes + read,
        );
        if (!n) break;
        lines.feed(buffer.subarray(0, n));
        read += n;
      }
      const aggregate = lines.finish();
      aggregates.push(aggregate);
      if (read === window.bytes && stamp(fileInfo(dir, window.file.name, fstatSync(fd))) === stamp(window.file))
        retain(store, window, aggregate);
      else stable = false;
    } catch {
      stable = false; /* 某个文件不可读不影响其它 scope */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  const result = summary(dir, names, aggregates, limits);
  let next = result.next();
  while (!next.done) next = result.next();
  if (stable) retainSummary(store, key, next.value);
  return next.value;
}

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** 生产入口：文件 I/O 异步，解析限于 64KB 一批，合并也分批让出事件循环。 */
export function readSummaryAsync(options: Record<string, unknown>): Promise<PerfMetrics> {
  // 内部共用读取工作，外部每个调用方各拿一份结果，不能共享可变数组或计数对象。
  return readAsyncAt(resolveLogDir(), limitsFor(options)).then(copySummary);
}

function readAsyncAt(dir: string, limits: Limits): Promise<PerfMetrics> {
  const key = JSON.stringify([epoch, dir, limits]);
  if (inFlight) {
    if (inFlight.key === key) return inFlight.promise;
    // 不同窗口 / 参数也串行读盘，避免冷启动时并发解析多份日志。
    return inFlight.promise.then(() => readAsyncAt(dir, limits));
  }
  const promise = collectAsync(dir, limits).finally(() => {
    if (inFlight?.promise === promise) inFlight = undefined;
  });
  inFlight = { key, promise };
  return promise;
}

async function collectAsync(dir: string, limits: Limits): Promise<PerfMetrics> {
  const store = cacheFor(dir, limits);
  const names: FileInfo[] = [];
  try {
    const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
    // 不给包含很多分片的目录同时发出几千个 stat。
    for (let i = 0; i < files.length; i += 16) {
      const batch = await Promise.all(
        files.slice(i, i + 16).map(async (name) => {
          try {
            const info = await stat(join(dir, name));
            return info.isFile() ? fileInfo(dir, name, info) : undefined;
          } catch {
            return undefined;
          }
        }),
      );
      for (const item of batch) if (item) names.push(item);
    }
  } catch {
    /* 尚未创建日志目录 */
  }
  const windows = windowsFor(names, limits, store);
  const key = summaryStamp(names, limits);
  if (store.summary?.stamp === key) return copySummary(store.summary.metrics);
  const aggregates: Aggregate[] = [];
  let stable = true;
  // 先取出已有命中，再放入新项；超过缓存容量时不提前逐出本轮后面的命中。
  const hits = windows.map((window) => cached(store, window));
  const buffer = Buffer.alloc(READ_BYTES);
  for (const [i, window] of windows.entries()) {
    const hit = hits[i];
    if (hit) {
      aggregates.push(hit);
      continue;
    }
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(window.file.path, 'r');
      const lines = new Lines(limits, window.file.bytes > window.bytes);
      let read = 0;
      while (read < window.bytes) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, window.bytes - read),
          window.file.bytes - window.bytes + read,
        );
        if (!bytesRead) break;
        lines.feed(buffer.subarray(0, bytesRead));
        read += bytesRead;
      }
      const aggregate = lines.finish();
      aggregates.push(aggregate);
      if (read === window.bytes && stamp(fileInfo(dir, window.file.name, await handle.stat())) === stamp(window.file))
        retain(store, window, aggregate);
      else stable = false;
    } catch {
      stable = false; /* 某个文件不可读不影响其它 scope */
    } finally {
      await handle?.close();
    }
    await yieldToLoop();
  }
  const result = summary(dir, names, aggregates, limits);
  let next = result.next();
  while (!next.done) {
    await yieldToLoop();
    next = result.next();
  }
  if (stable) retainSummary(store, key, next.value);
  return next.value;
}
