import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  Health,
  MicaChannelStat,
  MicaHostUsage,
  MicaMemoryPoint,
  MicaOverview,
  MicaPageStat,
  MicaProcessInfo,
  MicaProcessKind,
  MicaScopeFreshness,
  MicaSessionVolume,
  ProcessRecord,
  Range,
} from '../shared/types';
import { localDay, numberOrNull, tail, type Cursor } from './store';

/** Mica 诊断日志目录：与 packages/mica-diagnostics 的 resolveLogDir() 保持一致。 */
export const micaLogsDir = () => process.env.MICA_LOG_DIR || join(homedir(), 'Library/Logs/mica');
/** 会话快照目录：按 MICA_HOME 解析。 */
export const micaSessionsDir = () => join(process.env.MICA_HOME || join(homedir(), '.mica'), 'sessions');

const SCOPE_FILES = {
  mem: /^mem-(\d{8})\.jsonl(?:\.\d+)?$/,
  perf: /^perf-(\d{8})\.jsonl(?:\.\d+)?$/,
  invoke: /^invoke-(\d{8})\.jsonl(?:\.\d+)?$/,
  'app-server': /^app-server-(\d{8})\.jsonl(?:\.\d+)?$/,
  chat: /^chat-(\d{8})\.jsonl(?:\.\d+)?$/,
} as const;
type ScopeId = keyof typeof SCOPE_FILES;

const isoDay = (v: string) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
const minuteOf = (ts: number) => Math.floor(ts / 60000) * 60000;
const hoursOf: Record<Range, number> = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 };

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

/**
 * 把命令行归类成 Mica 的进程类型。只认 Mica 自身可执行文件，
 * 避免把 mica-lca-tame、mica-bridge、性能采集脚本等同样带 mica 的进程算进来。
 */
export function classifyMicaProcess(argv: string, name: string): { kind: string; session: string | null } | null {
  const s = `${argv} ${name}`;
  const desktop = /mica-code-app/.test(s);
  const cli = /\/\.local\/lib\/mica\/mica(?:\s|$)/.test(s) || /mica-code\/apps\/cli\/src\/index\.ts/.test(s);
  if (!desktop && !cli) return null;
  const session = /--session\s+(\S+)/.exec(argv)?.[1] ?? null;
  const lower = s.toLowerCase();
  if (/helper \(renderer\)/.test(lower)) return { kind: '渲染进程', session: null };
  if (/helper \(gpu\)/.test(lower)) return { kind: 'GPU 进程', session: null };
  if (/helper/.test(lower)) return { kind: '工具进程', session: null };
  if (/app-server/.test(lower)) return { kind: '会话宿主', session };
  if (/plugin-data|watchdog\.mjs|\.mjs(?:\s|$)/.test(lower)) return { kind: '插件进程', session: null };
  if (desktop) return { kind: '桌面主进程', session: null };
  return { kind: 'CLI / TUI', session };
}

export interface MicaProcessContext {
  at: string | null;
  rows: MicaProcessInfo[];
  desktopApp: string | null;
}

export function micaProcessRows(
  procs: ProcessRecord[],
  commands: Map<number, { name: string; argv: string }>,
  at: string | null,
): MicaProcessContext {
  const rows: MicaProcessInfo[] = [];
  let desktopApp: string | null = null;
  for (const p of procs) {
    const command = commands.get(p.pid);
    const argv = command?.argv ?? '';
    const classified = classifyMicaProcess(argv, `${p.n} ${command?.name ?? ''}`);
    if (!classified) continue;
    if (classified.kind === '桌面主进程' || classified.kind === '渲染进程') {
      const match = /(\/[^\s]+?\.app\/)/.exec(argv);
      if (match && !desktopApp) desktopApp = match[1];
    }
    rows.push({
      pid: p.pid,
      ppid: p.pp,
      kind: classified.kind,
      name: command?.name || p.n,
      footprintMb: p.fp,
      rssMb: p.rss,
      growthMb: numberOrNull(p.fpd),
      cpuPct: p.cpu,
      threads: p.th,
      command: argv || null,
      session: classified.session,
      orphan: p.pp === 1 && classified.kind !== '桌面主进程',
    });
  }
  return { at, rows, desktopApp };
}

interface HostSample {
  at: number;
  host: string;
  rss: number;
  session: string | null;
  turn: string | null;
  model: string | null;
  windows: number | null;
  hosts: number | null;
  busy: number | null;
  byType: Record<string, number> | null;
}
interface MemDay {
  buckets: Map<number, { hosts: Map<string, Map<number, number>>; byType: Map<string, { sum: number; n: number }> }>;
  latest: Map<number, HostSample>;
  series: Map<number, { ts: number; rss: number }[]>;
  counts: Map<number, number>;
  samples: number;
}
interface PageAcc {
  sid: string | null;
  samples: number;
  lastAt: number;
  heapMb: number | null;
  dom: number | null;
  rows: number | null;
  heap: Map<number, { max: number; last: number; dom: number | null; rows: number | null }>;
}
interface PerfDay {
  lag: Map<number, number[]>;
  values: number;
  dropped: number;
  samples: number;
  worst: { lag: number; at: number } | null;
  pages: Map<string, PageAcc>;
}
interface ChannelAcc {
  calls: number;
  slow: number;
  failed: number;
  values: number[];
  max: number | null;
}
interface InvokeDay {
  minutes: Map<number, Map<string, ChannelAcc>>;
  calls: number;
  slow: number;
  failed: number;
}
interface LifeDay {
  events: { at: number; pid: number; boot: boolean; session: string | null }[];
}
interface ChatDay {
  reaped: number;
  maxIdle: number | null;
  lastAt: number | null;
}

interface Watched<T> {
  cursor: Cursor;
  modified: number;
  size: number;
  data: T;
}

const emptyMem = (): MemDay => ({
  buckets: new Map(),
  latest: new Map(),
  series: new Map(),
  counts: new Map(),
  samples: 0,
});
const emptyPerf = (): PerfDay => ({ lag: new Map(), values: 0, dropped: 0, samples: 0, worst: null, pages: new Map() });
const emptyInvoke = (): InvokeDay => ({ minutes: new Map(), calls: 0, slow: 0, failed: 0 });
const emptyLife = (): LifeDay => ({ events: [] });
const emptyChat = (): ChatDay => ({ reaped: 0, maxIdle: null, lastAt: null });

const MAX_LAG_VALUES = 500_000;
const MAX_CHANNEL_VALUES = 20_000;

export class MicaStore {
  private memDays = new Map<string, Watched<MemDay>>();
  private perfDays = new Map<string, Watched<PerfDay>>();
  private invokeDays = new Map<string, Watched<InvokeDay>>();
  private lifeDays = new Map<string, Watched<LifeDay>>();
  private chatDays = new Map<string, Watched<ChatDay>>();
  private names: string[] = [];
  private dayList: string[] = [];
  private issues: string[] = [];
  private lastRefresh = 0;
  private refreshFlight: Promise<void> | null = null;
  private requestedDay = '';
  private requestedRange: Range | null = null;
  private sessionScan: { at: number; value: MicaOverview['sessions'] } | null = null;

  constructor(
    readonly logs = micaLogsDir(),
    readonly sessions = micaSessionsDir(),
  ) {}

  async refresh(day: string, range: Range): Promise<void> {
    if (this.refreshFlight) {
      await this.refreshFlight;
      return this.refresh(day, range);
    }
    if (Date.now() - this.lastRefresh < 5000 && day === this.requestedDay && range === this.requestedRange) return;
    this.requestedDay = day;
    this.requestedRange = range;
    this.refreshFlight = this.load(day, range).finally(() => {
      this.lastRefresh = Date.now();
      this.refreshFlight = null;
    });
    return this.refreshFlight;
  }

  private async load(day: string, range: Range) {
    this.names = await readdir(this.logs).catch(() => [] as string[]);
    this.issues = [];
    const days = new Set<string>();
    for (const name of this.names) {
      for (const pattern of Object.values(SCOPE_FILES)) {
        const match = pattern.exec(name);
        if (match) days.add(isoDay(match[1]));
      }
    }
    this.dayList = [...days].sort();
    // 只解析当前请求真正需要的日期：7 天窗口才回读历史，避免每次冷启动都重扫上百 MB 日志。
    const active = new Set<string>();
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      const anchor = new Date(`${day}T12:00:00`);
      const span = range === '7d' ? 6 : 0;
      for (let offset = 0; offset <= span; offset++) {
        const cursor = new Date(anchor);
        cursor.setDate(cursor.getDate() - offset);
        const value = isoDay(
          `${cursor.getFullYear()}${String(cursor.getMonth() + 1).padStart(2, '0')}${String(cursor.getDate()).padStart(2, '0')}`,
        );
        if (this.dayList.includes(value)) active.add(value);
      }
    }
    for (const cache of [this.memDays, this.perfDays, this.invokeDays, this.lifeDays, this.chatDays] as const)
      for (const key of cache.keys()) {
        const match = /-(\d{8})\.jsonl/.exec(key);
        if (!match || !active.has(isoDay(match[1]))) cache.delete(key);
      }
    for (const value of active) {
      const date = value.replaceAll('-', '');
      await this.watch(`mem-${date}`, this.memDays, emptyMem, consumeMem, resetMem);
      await this.watch(`perf-${date}`, this.perfDays, emptyPerf, consumePerf, resetPerf);
      await this.watch(`invoke-${date}`, this.invokeDays, emptyInvoke, consumeInvoke, resetInvoke);
      await this.watch(`app-server-${date}`, this.lifeDays, emptyLife, consumeLife, resetLife);
      await this.watch(`chat-${date}`, this.chatDays, emptyChat, consumeChat, resetChat);
    }
  }

  private async watch<T>(
    base: string,
    cache: Map<string, Watched<T>>,
    create: () => T,
    consume: (o: any, data: T) => void,
    reset: (data: T) => void,
  ): Promise<void> {
    const shards = this.names
      .filter((name) => {
        const match = /^(.*)-(\d{8})(\.jsonl(?:\.\d+)?)$/.exec(name);
        return match ? `${match[1]}-${match[2]}` === base : false;
      })
      .sort();
    if (!shards.length) {
      cache.delete(base);
      return;
    }
    for (const name of shards) {
      const path = join(this.logs, name);
      const st = await stat(path).catch(() => null);
      if (!st?.isFile()) continue;
      let entry = cache.get(name);
      if (!entry) {
        entry = { cursor: { ino: 0, offset: 0, errors: 0 }, modified: 0, size: 0, data: create() };
        cache.set(name, entry);
      }
      if (st.ino === entry.cursor.ino && st.size === entry.size && st.mtimeMs === entry.modified) continue;
      // Same inode but rewritten bytes (truncate + append) — re-read from the start.
      if (st.ino === entry.cursor.ino && (st.size < entry.size || (st.size === entry.size && st.mtimeMs !== entry.modified)))
        entry.cursor.ino = 0;
      try {
        await tail(path, entry.cursor, (o) => consume(o, entry!.data), () => reset(entry!.data));
      } catch (e) {
        this.issues.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      entry.modified = st.mtimeMs;
      entry.size = st.size;
    }
  }

  /** 合并本次刷新加载的全部日期与分片；时间窗口在各自 build 时筛选。 */
  private merge<T extends object>(cache: Map<string, Watched<T>>, data: T, mergeInto: (a: T, b: T) => void) {
    for (const entry of cache.values()) mergeInto(data, entry.data);
    return data;
  }

  async overview(day: string, range: Range, ctx: MicaProcessContext): Promise<MicaOverview> {
    await this.refresh(day, range);
    const hours = hoursOf[range];
    const mem = this.merge(this.memDays, emptyMem(), mergeMem);
    const perf = this.merge(this.perfDays, emptyPerf(), mergePerf);
    const invoke = this.merge(this.invokeDays, emptyInvoke(), mergeInvoke);
    const life = this.merge(this.lifeDays, emptyLife(), mergeLife);
    const chat = this.merge(this.chatDays, emptyChat(), mergeChat);

    const latestSample = [...mem.latest.values()].reduce<number | null>((a, b) => Math.max(a ?? 0, b.at), null);
    const dayEnd = latestSample ?? new Date(`${day}T23:59:59`).getTime();
    const end = day === localDay() ? Date.now() : dayEnd;
    const start = Math.max(
      range === '7d' ? 0 : new Date(`${day}T00:00:00`).getTime(),
      end - hours * 3600000,
    );

    const memory = buildMemory(mem, start, end);
    const hostView = buildHosts(mem, start, end);
    const renderer = buildRenderer(perf, start, end);
    const channelView = buildChannels(invoke, start, end);
    const sessions = await this.sessionVolume();

    const kinds = groupKinds(ctx.rows);
    const totals = {
      processes: ctx.rows.length,
      footprintMb: ctx.rows.reduce((sum, row) => sum + row.footprintMb, 0),
      rssMb: ctx.rows.reduce((sum, row) => sum + row.rssMb, 0),
      cpuPct: ctx.rows.some((row) => row.cpuPct !== null)
        ? ctx.rows.reduce((sum, row) => sum + (row.cpuPct ?? 0), 0)
        : null,
      appServers: ctx.rows.filter((row) => row.kind === '会话宿主').length,
    };

    const scopes = await this.scopeFreshness({
      mem: mem.samples,
      perf: perf.samples,
      invoke: invoke.calls,
      'app-server': life.events.length,
      chat: chat.reaped,
    });
    const findings: MicaOverview['findings'] = [];
    const add = (level: Health, title: string, detail: string) => findings.push({ level, title, detail });

    const orphans = ctx.rows.filter((row) => row.orphan);
    if (orphans.length)
      add(
        'critical',
        `${orphans.length} 个 Mica 进程的父进程已退出`,
        `${orphans
          .map((row) => `${row.kind} PID ${row.pid}（CPU ${row.cpuPct ?? '—'}%）`)
          .join('；')}。孤儿宿主会持续占 CPU，历史上出现过单进程空转数小时。`,
      );
    const hot = ctx.rows.filter((row) => (row.cpuPct ?? 0) >= 100);
    if (hot.length)
      add(
        'warning',
        `${hot.length} 个 Mica 进程占满一个核`,
        hot.map((row) => `${row.kind} PID ${row.pid} ${row.cpuPct}%`).join('；'),
      );
    if (renderer.lagP99 !== null && renderer.lagP99 > 16)
      add(
        'warning',
        '渲染帧间隔 p99 偏高',
        `窗口可见时的 p99 为 ${renderer.lagP99} ms；超过 32 ms 的帧 ${renderer.over32} 次。`,
      );
    const growing = hostView.rows.filter((host) => (host.growthMb ?? 0) >= 200).slice(0, 3);
    if (growing.length)
      add(
        'warning',
        '宿内存窗口内增长明显',
        growing.map((host) => `${host.host} PID ${host.pid} +${Math.round(host.growthMb ?? 0)} MB`).join('；'),
      );
    if (sessions.totalMb >= 500)
      add('warning', '会话快照目录超过 500 MB', `当前 ${Math.round(sessions.totalMb)} MB / ${sessions.count} 个会话文件。`);
    if (channelView.totals.calls > 0 && channelView.totals.slow / channelView.totals.calls > 0.02)
      add(
        'warning',
        '慢调用占比超过 2%',
        `${channelView.totals.slow} / ${channelView.totals.calls} 次；按通道排名见下表。`,
      );
    const memStale = scopes.find((scope) => scope.id === 'mem');
    if (memStale && memStale.state !== 'running')
      add('unknown', '内存采样已过期', '宿主内存来自每 30 秒一次的进程内采样；当前没有新数据。');

    const warnings = [
      '宿主内存来自 Mica 自身的每 30 秒采样（mem 作用域，按分钟汇总），与资源采集的 footprint 是两套口径，不能相互换算。',
      '渲染与调用耗时只覆盖发生时打开的窗口；页面隐藏时不产生渲染采样，没有数据不等于健康。',
      '进程 footprint 相加不等于物理内存使用量；进程 CPU 100% 表示一个逻辑核。',
      '会话宿主、渲染进程的归属依赖进程命令行与 PID 代次；PID 被复用时以当日登记为准。',
      '调用耗时来自 invoke 日志的 kind=call 记录，slow/failed 是同一批调用的附加判定，不重复计入次数。',
      ...this.issues,
    ];
    if (!perf.samples) warnings.push('所选日期没有渲染采样：Mica 窗口可能未打开，或该日期早于 perf-probe 上线。');
    if (!channelView.totals.calls) warnings.push('所选时间窗口没有 invoke 调用记录。');

    return {
      generatedAt: new Date().toISOString(),
      day,
      range,
      paths: {
        logs: this.logs,
        sessions: this.sessions,
        desktopApp: ctx.desktopApp,
      },
      hosts: hostView.rows,
      hostSummary: hostView.summary,
      memory,
      memoryNote: '宿主 RSS 按分钟取每个 PID 的最后一条采样后相加；app-server 汇总多宿主，不等于单个进程。',
      kinds,
      processAt: ctx.at,
      totals,
      renderer,
      channels: channelView.channels,
      invoke: channelView.totals,
      lifecycle: buildLifecycle(life),
      chat: {
        reaped: chat.reaped,
        maxIdleSeconds: chat.maxIdle,
        lastAt: chat.lastAt ? new Date(chat.lastAt).toISOString() : null,
      },
      sessions,
      scopes,
      findings,
      warnings,
    };
  }

  private async scopeFreshness(counters: Record<string, number>): Promise<MicaScopeFreshness[]> {
    const defs: { id: ScopeId; label: string; note: string; quietSeconds: number }[] = [
      { id: 'mem', label: '宿主内存', note: '每个宿主每 30 秒一条；宿主退出后不再写入。', quietSeconds: 300 },
      { id: 'perf', label: '渲染采样', note: '只在窗口可见时按秒采样；隐藏窗口不产生数据。', quietSeconds: 900 },
      { id: 'invoke', label: '主机调用', note: '桌面端每次 IPC 调用的耗时与失败。', quietSeconds: 900 },
      { id: 'app-server', label: '宿主生命周期', note: '只在启动与退出时写入，不按周期产生数据。', quietSeconds: 86400 },
      { id: 'chat', label: '窗口回收', note: '隐藏窗口到点销毁时记录；没有回收就保持安静。', quietSeconds: 86400 },
    ];
    const rows: MicaScopeFreshness[] = [];
    for (const def of defs) {
      const pattern = SCOPE_FILES[def.id];
      const files = this.names.filter((name) => pattern.test(name)).sort().reverse();
      const file = files[0] ?? null;
      const st = file ? await stat(join(this.logs, file)).catch(() => null) : null;
      const samples = counters[def.id] ?? 0;
      const age = st ? (Date.now() - st.mtimeMs) / 1000 : null;
      rows.push({
        id: def.id,
        scope: def.label,
        file,
        lastAt: st ? new Date(st.mtimeMs).toISOString() : null,
        bytes: st?.size ?? 0,
        samples,
        state: !st ? 'unavailable' : age !== null && age <= def.quietSeconds ? 'running' : 'stale',
        note: def.note,
      });
    }
    return rows;
  }

  private async sessionVolume(): Promise<MicaOverview['sessions']> {
    if (this.sessionScan && Date.now() - this.sessionScan.at < 60_000) return this.sessionScan.value;
    let names: string[] = [];
    try {
      names = await readdir(this.sessions);
    } catch (e) {
      const value = {
        count: 0,
        totalMb: 0,
        largest: [] as MicaSessionVolume[],
        error: `无法读取会话目录：${e instanceof Error ? e.message : String(e)}`,
      };
      this.sessionScan = { at: Date.now(), value };
      return value;
    }
    const files = names.filter((name) => name.endsWith('.json'));
    let total = 0;
    const sizes: MicaSessionVolume[] = [];
    for (const name of files) {
      const st = await stat(join(this.sessions, name)).catch(() => null);
      if (!st?.isFile()) continue;
      total += st.size;
      sizes.push({
        id: name.slice(0, -5),
        sizeMb: st.size / 1048576,
        updatedAt: new Date(st.mtimeMs).toISOString(),
      });
    }
    sizes.sort((a, b) => b.sizeMb - a.sizeMb);
    const value = { count: files.length, totalMb: total / 1048576, largest: sizes.slice(0, 5), error: null };
    this.sessionScan = { at: Date.now(), value };
    return value;
  }
}

function consumeMem(o: any, d: MemDay) {
  if (o?.scope !== 'mem' || o?.event !== 'sample') return;
  const ts = Number(o.at);
  const pid = Number(o.pid);
  const rss = numberOrNull(o.rss);
  const host = String(o.host ?? '');
  if (!Number.isFinite(ts) || !Number.isInteger(pid) || rss === null || !host) return;
  d.samples++;
  const minute = minuteOf(ts);
  let bucket = d.buckets.get(minute);
  if (!bucket) {
    bucket = { hosts: new Map(), byType: new Map() };
    d.buckets.set(minute, bucket);
  }
  let byPid = bucket.hosts.get(host);
  if (!byPid) {
    byPid = new Map();
    bucket.hosts.set(host, byPid);
  }
  byPid.set(pid, rss);
  const byType = o.byType && typeof o.byType === 'object' ? (o.byType as Record<string, unknown>) : null;
  const typed: Record<string, number> = {};
  if (byType)
    for (const [key, value] of Object.entries(byType)) {
      const parsed = numberOrNull(value);
      if (parsed === null) continue;
      typed[key] = parsed;
      const acc = bucket.byType.get(key) ?? { sum: 0, n: 0 };
      acc.sum += parsed;
      acc.n++;
      bucket.byType.set(key, acc);
    }
  const previous = d.latest.get(pid);
  if (!previous || ts >= previous.at)
    d.latest.set(pid, {
      at: ts,
      host,
      rss,
      session: typeof o.session === 'string' ? o.session : null,
      turn: typeof o.turn === 'string' ? o.turn : null,
      model: typeof o.model === 'string' ? o.model : null,
      windows: numberOrNull(o.windows),
      hosts: numberOrNull(o.hosts),
      busy: numberOrNull(o.busy),
      byType: Object.keys(typed).length ? typed : null,
    });
  const series = d.series.get(pid) ?? [];
  if (!series.length || ts - series[series.length - 1].ts >= 300_000) series.push({ ts, rss });
  d.series.set(pid, series);
  d.counts.set(pid, (d.counts.get(pid) ?? 0) + 1);
}
function resetMem(d: MemDay) {
  d.buckets.clear();
  d.latest.clear();
  d.series.clear();
  d.counts.clear();
  d.samples = 0;
}

function consumePerf(o: any, d: PerfDay) {
  if (o?.scope !== 'perf') return;
  if (o.event === 'batch') {
    d.dropped += Number(o.dropped) || 0;
    return;
  }
  if (o.event !== 'sample') return;
  const ts = Number(o.at);
  if (!Number.isFinite(ts)) return;
  d.samples++;
  const lag = numberOrNull(o.lag);
  const visible = Number(o.vis) === 1;
  if (lag !== null && visible) {
    if (d.values < MAX_LAG_VALUES) {
      const minute = minuteOf(ts);
      const bucket = d.lag.get(minute) ?? [];
      bucket.push(lag);
      d.lag.set(minute, bucket);
      d.values++;
    } else d.dropped++;
    if (!d.worst || lag > d.worst.lag) d.worst = { lag, at: ts };
  }
  const pageId = typeof o.pageId === 'string' ? o.pageId : '';
  if (!pageId) return;
  const heap = numberOrNull(o.heapMB);
  const dom = numberOrNull(o.dom);
  const rows = numberOrNull(o.rows);
  const page = d.pages.get(pageId) ?? {
    sid: null,
    samples: 0,
    lastAt: 0,
    heapMb: null,
    dom: null,
    rows: null,
    heap: new Map(),
  };
  page.samples++;
  if (ts >= page.lastAt) {
    page.lastAt = ts;
    if (typeof o.sid === 'string') page.sid = o.sid;
    if (heap !== null) page.heapMb = heap;
    if (dom !== null) page.dom = dom;
    if (rows !== null) page.rows = rows;
  }
  if (heap !== null) {
    const minute = minuteOf(ts);
    const entry = page.heap.get(minute) ?? { max: heap, last: heap, dom, rows };
    entry.max = Math.max(entry.max, heap);
    entry.last = heap;
    if (dom !== null) entry.dom = dom;
    if (rows !== null) entry.rows = rows;
    page.heap.set(minute, entry);
  }
  d.pages.set(pageId, page);
}
function resetPerf(d: PerfDay) {
  d.lag.clear();
  d.values = 0;
  d.dropped = 0;
  d.samples = 0;
  d.worst = null;
  d.pages.clear();
}

function consumeInvoke(o: any, d: InvokeDay) {
  if (o?.scope !== 'invoke') return;
  const ts = Number(o.at);
  const channel = typeof o.event === 'string' ? o.event : '';
  if (!Number.isFinite(ts) || !channel) return;
  const kind = String(o.kind ?? 'call');
  const ms = numberOrNull(o.ms);
  const minute = minuteOf(ts);
  let bucket = d.minutes.get(minute);
  if (!bucket) {
    bucket = new Map();
    d.minutes.set(minute, bucket);
  }
  const acc = bucket.get(channel) ?? { calls: 0, slow: 0, failed: 0, values: [], max: null };
  if (kind === 'slow') {
    d.slow++;
    acc.slow++;
  } else if (kind === 'failed' || o.level === 'error') {
    d.failed++;
    acc.failed++;
  } else {
    d.calls++;
    acc.calls++;
    if (ms !== null && acc.values.length < MAX_CHANNEL_VALUES) {
      acc.values.push(ms);
      acc.max = acc.max === null ? ms : Math.max(acc.max, ms);
    }
  }
  bucket.set(channel, acc);
}
function resetInvoke(d: InvokeDay) {
  d.minutes.clear();
  d.calls = 0;
  d.slow = 0;
  d.failed = 0;
}

function consumeLife(o: any, d: LifeDay) {
  if (o?.scope !== 'app-server') return;
  const ts = Number(o.at);
  const pid = Number(o.pid);
  if (!Number.isFinite(ts) || !Number.isInteger(pid)) return;
  if (o.event !== 'boot' && o.event !== 'shutdown') return;
  const argv = typeof o.argv === 'string' ? o.argv : '';
  const session = /--session\s+(\S+)/.exec(argv)?.[1] ?? null;
  d.events.push({ at: ts, pid, boot: o.event === 'boot', session });
}
function resetLife(d: LifeDay) {
  d.events = [];
}

function consumeChat(o: any, d: ChatDay) {
  if (o?.scope !== 'chat' || o?.event !== 'chat.idle-reap') return;
  const ts = Number(o.at);
  if (!Number.isFinite(ts)) return;
  d.reaped++;
  d.lastAt = Math.max(d.lastAt ?? 0, ts);
  const idle = numberOrNull(o.idleSeconds);
  if (idle !== null) d.maxIdle = d.maxIdle === null ? idle : Math.max(d.maxIdle, idle);
}
function resetChat(d: ChatDay) {
  d.reaped = 0;
  d.maxIdle = null;
  d.lastAt = null;
}

function mergeMem(into: MemDay, from: MemDay) {
  into.samples += from.samples;
  for (const [minute, bucket] of from.buckets) {
    const target = into.buckets.get(minute) ?? { hosts: new Map(), byType: new Map() };
    for (const [host, pids] of bucket.hosts) {
      const list = target.hosts.get(host) ?? new Map<number, number>();
      for (const [pid, rss] of pids) list.set(pid, rss);
      target.hosts.set(host, list);
    }
    for (const [key, acc] of bucket.byType) {
      const prev = target.byType.get(key) ?? { sum: 0, n: 0 };
      prev.sum += acc.sum;
      prev.n += acc.n;
      target.byType.set(key, prev);
    }
    into.buckets.set(minute, target);
  }
  for (const [pid, sample] of from.latest) {
    const prev = into.latest.get(pid);
    if (!prev || sample.at >= prev.at) into.latest.set(pid, sample);
  }
  for (const [pid, series] of from.series) {
    const list = into.series.get(pid) ?? [];
    into.series.set(pid, [...list, ...series].sort((a, b) => a.ts - b.ts));
  }
  for (const [pid, count] of from.counts) into.counts.set(pid, (into.counts.get(pid) ?? 0) + count);
}
function mergePerf(into: PerfDay, from: PerfDay) {
  into.samples += from.samples;
  into.dropped += from.dropped;
  for (const [minute, values] of from.lag) {
    const list = into.lag.get(minute) ?? [];
    list.push(...values);
    into.lag.set(minute, list);
  }
  if (from.worst && (!into.worst || from.worst.lag > into.worst.lag)) into.worst = from.worst;
  for (const [pageId, page] of from.pages) {
    const prev = into.pages.get(pageId) ?? {
      sid: null,
      samples: 0,
      lastAt: 0,
      heapMb: null,
      dom: null,
      rows: null,
      heap: new Map(),
    };
    prev.samples += page.samples;
    if (page.lastAt >= prev.lastAt) {
      prev.lastAt = page.lastAt;
      prev.sid = page.sid ?? prev.sid;
      prev.heapMb = page.heapMb ?? prev.heapMb;
      prev.dom = page.dom ?? prev.dom;
      prev.rows = page.rows ?? prev.rows;
    }
    for (const [minute, entry] of page.heap) {
      const target = prev.heap.get(minute);
      if (!target) prev.heap.set(minute, entry);
      else {
        target.max = Math.max(target.max, entry.max);
        target.last = entry.last;
        target.dom = entry.dom ?? target.dom;
        target.rows = entry.rows ?? target.rows;
      }
    }
    into.pages.set(pageId, prev);
  }
  into.values = [...into.lag.values()].reduce((sum, list) => sum + list.length, 0);
}
function mergeInvoke(into: InvokeDay, from: InvokeDay) {
  into.calls += from.calls;
  into.slow += from.slow;
  into.failed += from.failed;
  for (const [minute, bucket] of from.minutes) {
    const target = into.minutes.get(minute) ?? new Map<string, ChannelAcc>();
    for (const [channel, acc] of bucket) {
      const prev = target.get(channel) ?? { calls: 0, slow: 0, failed: 0, values: [], max: null };
      prev.calls += acc.calls;
      prev.slow += acc.slow;
      prev.failed += acc.failed;
      prev.values.push(...acc.values);
      prev.max = prev.max === null ? acc.max : acc.max === null ? prev.max : Math.max(prev.max, acc.max);
      target.set(channel, prev);
    }
    into.minutes.set(minute, target);
  }
}
function mergeLife(into: LifeDay, from: LifeDay) {
  into.events.push(...from.events);
  into.events.sort((a, b) => a.at - b.at);
}
function mergeChat(into: ChatDay, from: ChatDay) {
  into.reaped += from.reaped;
  into.maxIdle = Math.max(into.maxIdle ?? 0, from.maxIdle ?? 0) || null;
  into.lastAt = Math.max(into.lastAt ?? 0, from.lastAt ?? 0) || null;
}

function buildMemory(mem: MemDay, start: number, end: number): MicaMemoryPoint[] {
  const points: MicaMemoryPoint[] = [];
  const minutes = [...mem.buckets.keys()].filter((ts) => ts >= start - 60_000 && ts <= end).sort((a, b) => a - b);
  for (const minute of minutes) {
    const bucket = mem.buckets.get(minute)!;
    const sum = (host: string) => {
      const pids = bucket.hosts.get(host);
      if (!pids?.size) return null;
      let total = 0;
      for (const rss of pids.values()) total += rss;
      return total;
    };
    const avg = (key: string) => {
      const acc = bucket.byType.get(key);
      return acc && acc.n ? acc.sum / acc.n : null;
    };
    points.push({
      ts: minute,
      main: sum('main'),
      runtime: sum('runtime'),
      appServer: sum('app-server'),
      tui: sum('tui'),
      gpu: avg('GPU'),
      tab: avg('Tab'),
      utility: avg('Utility'),
    });
  }
  return downsampleMica(points, 720);
}
function downsampleMica(points: MicaMemoryPoint[], buckets: number): MicaMemoryPoint[] {
  if (points.length <= buckets) return points;
  const width = Math.ceil(points.length / buckets);
  const out: MicaMemoryPoint[] = [];
  const keys = ['main', 'runtime', 'appServer', 'tui', 'gpu', 'tab', 'utility'] as const;
  for (let i = 0; i < points.length; i += width) {
    const group = points.slice(i, i + width);
    const point: MicaMemoryPoint = {
      ts: group[group.length - 1].ts,
      main: null,
      runtime: null,
      appServer: null,
      tui: null,
      gpu: null,
      tab: null,
      utility: null,
    };
    for (const key of keys) {
      const values = group.map((p) => p[key]).filter((v): v is number => typeof v === 'number');
      point[key] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    }
    out.push(point);
  }
  return out;
}

function buildHosts(
  mem: MemDay,
  start: number,
  end: number,
): { rows: MicaHostUsage[]; summary: MicaOverview['hostSummary'] } {
  const rows: MicaHostUsage[] = [];
  // 只有最近十分钟仍有采样的宿主才算「活着」；更早的是已退出的宿主，只计入窗口总数。
  const activeCutoff = Math.max(start, end - 600_000);
  let windowHosts = 0;
  let shortLived = 0;
  let peak: { rss: number; label: string } | null = null;
  for (const [pid, sample] of mem.latest) {
    if (sample.at < start || sample.at > end) continue;
    windowHosts++;
    const samples = mem.counts.get(pid) ?? 0;
    if (samples <= 2) shortLived++;
    // 只出现一两次的宿主是测试或一次性命令留下的瞬时进程，不进列表，避免把表格撑成几百行。
    if (samples <= 2) continue;
    const label = sample.session ? `${sample.host} · ${sample.session}` : `${sample.host} · PID ${pid}`;
    if (!peak || sample.rss > peak.rss) peak = { rss: sample.rss, label };
    if (sample.at < activeCutoff) continue;
    const series = (mem.series.get(pid) ?? []).filter((point) => point.ts >= start && point.ts <= end);
    const first = series[0]?.rss ?? null;
    const last = series.at(-1)?.rss ?? null;
    rows.push({
      pid,
      host: sample.host,
      rssMb: sample.rss,
      lastAt: new Date(sample.at).toISOString(),
      firstRssMb: first,
      growthMb: first !== null && last !== null ? last - first : null,
      session: sample.session,
      turn: sample.turn,
      model: sample.model,
      windows: sample.windows,
      hosts: sample.hosts,
      busy: sample.busy,
      byType: sample.byType,
      samples,
    });
  }
  rows.sort((a, b) => b.rssMb - a.rssMb);
  return {
    rows,
    summary: {
      activeHosts: rows.length,
      windowHosts,
      peakHostRssMb: peak?.rss ?? null,
      peakHostLabel: peak?.label ?? null,
      shortLived,
    },
  };
}

function buildLifecycle(life: LifeDay): MicaOverview['lifecycle'] {
  const sessions = new Set<string>();
  const open = new Map<number, { at: number; boot: boolean }>();
  let boots = 0;
  let shutdowns = 0;
  let lastBootAt: number | null = null;
  for (const event of life.events) {
    if (event.boot) {
      boots++;
      lastBootAt = Math.max(lastBootAt ?? 0, event.at);
      if (event.session) sessions.add(event.session);
    } else shutdowns++;
    open.set(event.pid, { at: event.at, boot: event.boot });
  }
  return {
    boots,
    shutdowns,
    sessions: [...sessions].sort(),
    lastBootAt: lastBootAt ? new Date(lastBootAt).toISOString() : null,
    openPids: [...open.values()].filter((entry) => entry.boot).length,
  };
}

function buildRenderer(perf: PerfDay, start: number, end: number): MicaOverview['renderer'] {
  const values: number[] = [];
  for (const [minute, list] of perf.lag) {
    if (minute < start - 60_000 || minute > end) continue;
    for (const value of list) values.push(value);
  }
  values.sort((a, b) => a - b);
  const pages: MicaPageStat[] = [];
  let main: PageAcc | null = null;
  for (const [pageId, page] of perf.pages) {
    if (!page.samples) continue;
    if (!main || page.samples > main.samples) main = page;
    const minutes = [...page.heap.keys()].filter((ts) => ts >= start - 60_000 && ts <= end).sort((a, b) => a - b);
    const heapFirst = minutes.length ? page.heap.get(minutes[0])!.last : null;
    const heapMax = minutes.length ? Math.max(...minutes.map((ts) => page.heap.get(ts)!.max)) : null;
    const heapLast = minutes.length ? page.heap.get(minutes.at(-1)!)!.last : null;
    pages.push({
      pageId,
      sid: page.sid,
      samples: page.samples,
      lastAt: new Date(page.lastAt).toISOString(),
      heapMb: heapLast ?? page.heapMb,
      heapMaxMb: heapMax,
      heapFirstMb: heapFirst,
      dom: page.dom,
      rows: page.rows,
    });
  }
  const heap: MicaOverview['renderer']['heap'] = [];
  if (main) {
    const minutes = [...main.heap.keys()].filter((ts) => ts >= start - 60_000 && ts <= end).sort((a, b) => a - b);
    for (const minute of minutes) {
      const entry = main.heap.get(minute)!;
      heap.push({ ts: minute, heapMb: entry.last, heapMaxMb: entry.max, dom: entry.dom });
    }
  }
  const worst = perf.worst && perf.worst.at >= start && perf.worst.at <= end ? perf.worst : null;
  return {
    samples: values.length,
    lagP50: percentile(values, 0.5),
    lagP95: percentile(values, 0.95),
    lagP99: percentile(values, 0.99),
    over32: values.filter((v) => v > 32).length,
    over100: values.filter((v) => v > 100).length,
    over1000: values.filter((v) => v > 1000).length,
    worst: worst?.lag ?? null,
    worstAt: worst ? new Date(worst.at).toISOString() : null,
    dropped: perf.dropped,
    pages: pages.sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
    heap: heap.slice(-1440),
  };
}

function buildChannels(
  invoke: InvokeDay,
  start: number,
  end: number,
): { channels: MicaChannelStat[]; totals: MicaOverview['invoke'] } {
  const merged = new Map<string, ChannelAcc & { lastAt: number }>();
  const totals = { calls: 0, slow: 0, failed: 0 };
  for (const [minute, bucket] of invoke.minutes) {
    if (minute < start - 60_000 || minute > end) continue;
    for (const [channel, acc] of bucket) {
      totals.calls += acc.calls;
      totals.slow += acc.slow;
      totals.failed += acc.failed;
      const prev = merged.get(channel) ?? { calls: 0, slow: 0, failed: 0, values: [], max: null, lastAt: 0 };
      prev.calls += acc.calls;
      prev.slow += acc.slow;
      prev.failed += acc.failed;
      prev.values.push(...acc.values);
      prev.max = prev.max === null ? acc.max : acc.max === null ? prev.max : Math.max(prev.max, acc.max);
      prev.lastAt = Math.max(prev.lastAt, minute);
      merged.set(channel, prev);
    }
  }
  const rows: MicaChannelStat[] = [];
  for (const [channel, acc] of merged) {
    const sorted = [...acc.values].sort((a, b) => a - b);
    rows.push({
      channel,
      calls: acc.calls,
      slow: acc.slow,
      failed: acc.failed,
      p95Ms: percentile(sorted, 0.95),
      maxMs: acc.max,
      lastAt: acc.lastAt ? new Date(acc.lastAt).toISOString() : null,
    });
  }
  return { channels: rows.sort((a, b) => b.calls - a.calls).slice(0, 24), totals };
}

function groupKinds(rows: MicaProcessInfo[]): MicaProcessKind[] {
  const map = new Map<string, MicaProcessInfo[]>();
  for (const row of rows) {
    const list = map.get(row.kind) ?? [];
    list.push(row);
    map.set(row.kind, list);
  }
  const out: MicaProcessKind[] = [];
  for (const [kind, list] of map) {
    const withCpu = list.some((row) => row.cpuPct !== null);
    out.push({
      kind,
      count: list.length,
      footprintMb: list.reduce((sum, row) => sum + row.footprintMb, 0),
      rssMb: list.reduce((sum, row) => sum + row.rssMb, 0),
      cpuPct: withCpu ? list.reduce((sum, row) => sum + (row.cpuPct ?? 0), 0) : null,
      processes: list.sort((a, b) => b.footprintMb - a.footprintMb),
    });
  }
  return out.sort((a, b) => b.footprintMb - a.footprintMb);
}
