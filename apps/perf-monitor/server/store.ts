import { access, open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import type {
  ArtifactContent,
  GroupSummary,
  IncidentDetail,
  IncidentSummary,
  ProcessDetail,
  ProcessRecord,
  Range,
  Sample,
  SystemState,
  TrendPoint,
} from '../shared/types';

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const RESOURCE_RE = /^resource-(\d{8})\.jsonl(?:\.\d+)?$/;
const CPU_RE = /^cpu-(\d{8})\.log(?:\.\d+)?$/;
const REGISTRY_RE = /^registry-(\d{8})\.jsonl(?:\.\d+)?$/;
const INCIDENT_RE = /^\d{8}-\d{6}$/;
const MAX_FILE = 128 * 1024 * 1024;
export const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const n = (v: unknown) => numberOrNull(v) ?? 0;
const isoDay = (v: string) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
export const localDay = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export function validDay(v: string): boolean {
  if (!DAY_RE.test(v)) return false;
  const d = new Date(`${v}T12:00:00`);
  return Number.isFinite(d.getTime()) && localDay(d) === v;
}
export function redact(text: string): string {
  return text
    .replace(
      /((?:--?|\b)(?:[a-z0-9]+[-_])*(?:api[-_]?key|token|secret(?:[-_]?key)?|password|authorization|access[-_]?key|private[-_]?key)["']?(?:\s*[=:]\s*|\s+))(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer|Basic)\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;]+)|[^\s"',;]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[REDACTED]@');
}
export function groupFor(name: string, argv = ''): string {
  const s = `${name} ${argv}`.toLowerCase();
  if (/lcasensor|lcamon|lcanetmon|lcaagent|lcallmproxy|\/didi\/lca/.test(s)) return 'LCA';
  if (/d-chat/.test(s)) return 'D-Chat';
  if (/tencentmeeting|voov/.test(s)) return '腾讯会议';
  if (/windowserver/.test(s)) return 'WindowServer';
  if (/mdworker|mds_stores|\bmds\b/.test(s)) return 'Spotlight';
  if (/sequential-thinking|modelcontextprotocol/.test(s)) return 'MCP';
  if (/mica|mica-code-app/.test(s)) return 'Mica';
  if (/visual studio code|code helper/.test(s)) return 'VS Code';
  if (/google chrome|\/chromium(?:\.app|\/|\s|$)/.test(s)) return 'Chrome';
  if (/spotify/.test(s)) return 'Spotify';
  if (/\b(node|bun|npm|tsc|vite)\b/.test(s)) return '开发工具';
  return '其他';
}
interface RegistryEntry {
  pid: number;
  pp: number;
  start: string;
  ts: number;
  argv: string;
  name: string;
}
interface Cursor {
  ino: number;
  offset: number;
  errors: number;
}
interface FileState extends Cursor {
  points: TrendPoint[];
  latest: Sample | null;
  lastUptime: number | null;
  modified: number;
  size: number;
}
interface RegistryFile extends Cursor {
  rows: Map<number, RegistryEntry[]>;
  modified: number;
  size: number;
}
interface ProcessObservation {
  ts: number;
  raw: any;
  warmup: boolean;
  schema: number;
}
interface ProcessFile extends Cursor {
  rows: ProcessObservation[];
  modified: number;
  size: number;
}
interface ProcessQuery {
  files: Map<string, ProcessFile>;
  signature: string;
  result: ProcessDetail | null;
}
export function systemState(raw: Record<string, unknown> = {}): SystemState {
  const disk = raw.disk as Record<string, unknown> | null;
  return {
    cpu_pct: numberOrNull(raw.cpu_pct),
    swap_used_mb: numberOrNull(raw.swap_used_mb),
    swap_total_mb: numberOrNull(raw.swap_total_mb),
    free_mb: numberOrNull(raw.free_mb),
    compressor_mb: numberOrNull(raw.compressor_mb),
    wired_mb: numberOrNull(raw.wired_mb),
    pressure: numberOrNull(raw.pressure),
    disk_free_gb: numberOrNull(raw.disk_free_gb),
    disk_used_pct: numberOrNull(raw.disk_used_pct),
    uptime_h: numberOrNull(raw.uptime_h),
    swapin_mb_s: numberOrNull(raw.swapin_mb_s),
    swapout_mb_s: numberOrNull(raw.swapout_mb_s),
    thrashing_detected: numberOrNull(raw.thrashing_detected),
    disk:
      disk && numberOrNull(disk.mb_s) !== null
        ? { mb_s: n(disk.mb_s), tps: n(disk.tps), kb_per_transfer: n(disk.kb_per_transfer) }
        : null,
    load: Array.isArray(raw.load) ? raw.load.filter((x): x is number => numberOrNull(x) !== null) : [],
  };
}
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Old MEM lines lack pressure, disk, PID memory and page size: keep those unknown. */
export function parseCpuMemory(line: string, day: string): Sample | null {
  const time = /^(\d{2}:\d{2}:\d{2})\s+MEM\s/.exec(line)?.[1];
  if (!time) return null;
  const epoch = Date.parse(`${day}T${time}`);
  if (!Number.isFinite(epoch)) return null;
  const value = (key: string) => {
    const m = new RegExp(`\\b${key}=([\\d.]+)M`).exec(line);
    return m ? Number(m[1]) : null;
  };
  const swap = /swap=([\d.]+)\/([\d.]+)M/.exec(line);
  const swapIn = /swapin=[\d.]+\/s\(([\d.]+)MB\/s\)/.exec(line);
  return {
    ts: new Date(epoch).toISOString(),
    epoch,
    dt: 60,
    source: 'cpu-text',
    sys: systemState({
      swap_used_mb: swap ? Number(swap[1]) : null,
      swap_total_mb: swap ? Number(swap[2]) : null,
      free_mb: value('free'),
      compressor_mb: value('compress'),
      wired_mb: value('wired'),
      swapin_mb_s: swapIn ? Number(swapIn[1]) : null,
    }),
    agg: { count: 0, footprint_mb: 0, cpu_pct: null, threads: 0 },
    procs: [],
    fullCount: null,
  };
}

/** Only complete newline-terminated records are consumed. Readers can run during append/rotation. */
async function tail(path: string, cursor: Cursor, consume: (obj: any) => void, reset: () => void, rawLines = false) {
  const st = await stat(path);
  if (st.size > MAX_FILE) throw new Error(`日志超过单文件读取上限：${basename(path)}`);
  if (st.ino !== cursor.ino || st.size < cursor.offset) {
    cursor.ino = st.ino;
    cursor.offset = 0;
    cursor.errors = 0;
    reset();
  }
  if (st.size <= cursor.offset) return;
  const file = await open(path, 'r');
  let position = cursor.offset;
  let pending = Buffer.alloc(0);
  try {
    while (position < st.size) {
      const chunk = Buffer.allocUnsafe(Math.min(256 * 1024, st.size - position));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let from = 0;
      let i = pending.indexOf(10, from);
      while (i !== -1) {
        const line = pending.subarray(from, i).toString('utf8');
        if (line.trim()) {
          try {
            consume(rawLines ? line : JSON.parse(line));
          } catch {
            cursor.errors++;
          }
        }
        from = i + 1;
        i = pending.indexOf(10, from);
      }
      pending = Buffer.from(pending.subarray(from));
      cursor.offset = position - pending.length;
      if (pending.length > 4 * 1024 * 1024) throw new Error(`日志单行过大：${basename(path)}`);
    }
  } finally {
    await file.close();
  }
}

export class TelemetryStore {
  private files = new Map<string, FileState>();
  private cpuFiles = new Map<string, FileState>();
  private registries = new Map<string, RegistryFile>();
  private registryFlights = new Map<string, Promise<void>>();
  private processQueries = new Map<string, ProcessQuery>();
  private processFlights = new Map<string, Promise<ProcessDetail | null>>();
  private refreshFlight: Promise<void> | null = null;
  private requestedDay: string | undefined;
  private lastRefresh = 0;
  private names: string[] = [];
  private issues: string[] = [];
  constructor(readonly root: string) {}

  async refresh(requestedDay = this.requestedDay): Promise<void> {
    if (this.refreshFlight) {
      await this.refreshFlight;
      return this.refresh(requestedDay);
    }
    if (Date.now() - this.lastRefresh < 5000 && requestedDay === this.requestedDay) return;
    this.requestedDay = requestedDay;
    this.refreshFlight = this.load(requestedDay).finally(() => {
      this.lastRefresh = Date.now();
      this.refreshFlight = null;
    });
    return this.refreshFlight;
  }
  private async load(requestedDay?: string) {
    try {
      this.names = await readdir(this.root);
    } catch {
      this.names = [];
    }
    this.issues = [];
    const resources = this.names.filter((x) => RESOURCE_RE.test(x));
    const cpuNames = this.names.filter((x) => CPU_RE.test(x));
    const availableDays = [
      ...new Set([...resources, ...cpuNames].map((x) => isoDay((RESOURCE_RE.exec(x) ?? CPU_RE.exec(x))![1]))),
    ].sort();
    const days = new Set(availableDays.slice(-8));
    // Preserve collector freshness even if only the independent CPU watcher has run recently.
    const latestResourceDay = resources
      .map((x) => isoDay(RESOURCE_RE.exec(x)![1]))
      .sort()
      .at(-1);
    if (latestResourceDay) days.add(latestResourceDay);
    if (requestedDay && validDay(requestedDay)) {
      const first = new Date(`${requestedDay}T12:00:00`);
      first.setDate(first.getDate() - 7);
      const firstDay = localDay(first);
      for (const day of availableDays) if (day >= firstDay && day <= requestedDay) days.add(day);
    }
    for (const [cache, pattern] of [
      [this.files, RESOURCE_RE],
      [this.cpuFiles, CPU_RE],
      [this.registries, REGISTRY_RE],
    ] as const) {
      for (const name of cache.keys())
        if (!this.names.includes(name) || !days.has(isoDay(pattern.exec(name)![1]))) cache.delete(name);
    }
    for (const day of days) await this.loadRegistry(day);
    for (const name of resources) {
      const day = isoDay(RESOURCE_RE.exec(name)![1]);
      if (!days.has(day)) continue;
      const path = join(this.root, name);
      let f = this.files.get(name);
      if (!f) {
        f = { ino: 0, offset: 0, errors: 0, points: [], latest: null, lastUptime: null, modified: 0, size: 0 };
        this.files.set(name, f);
      }
      try {
        const st = await stat(path);
        if (st.ino === f.ino && st.mtimeMs === f.modified && st.size === f.size) continue;
        const target = f;
        await tail(
          path,
          target,
          (o) => {
            if (o.k !== 'sample' || !o.sys || !Array.isArray(o.procs)) return;
            const sample = this.sample(o, day);
            if (!sample) return;
            target.points.push(this.point(sample));
            if (!target.latest || sample.epoch >= target.latest.epoch) target.latest = sample;
          },
          () => {
            target.points = [];
            target.latest = null;
          },
        );
        f.modified = st.mtimeMs;
        f.size = st.size;
      } catch (e) {
        this.issues.push(String(e));
      }
    }
    for (const name of cpuNames) {
      const day = isoDay(CPU_RE.exec(name)![1]);
      if (!days.has(day)) continue;
      let f = this.cpuFiles.get(name);
      if (!f) {
        f = { ino: 0, offset: 0, errors: 0, points: [], latest: null, lastUptime: null, modified: 0, size: 0 };
        this.cpuFiles.set(name, f);
      }
      const target = f;
      try {
        const st = await stat(join(this.root, name));
        if (st.ino === f.ino && st.mtimeMs === f.modified && st.size === f.size) continue;
        await tail(
          join(this.root, name),
          target,
          (line: string) => {
            const s = parseCpuMemory(line, day);
            if (!s) return;
            const point = this.point(s);
            point.gpuPct = numberOrNull(
              /gpu=([\d.]+)%/.exec(line)?.[1] ? Number(/gpu=([\d.]+)%/.exec(line)![1]) : null,
            );
            target.points.push(point);
            if (!target.latest || s.epoch >= target.latest.epoch) target.latest = s;
          },
          () => {
            target.points = [];
            target.latest = null;
          },
          true,
        );
        f.modified = st.mtimeMs;
        f.size = st.size;
      } catch (e) {
        this.issues.push(String(e));
      }
    }
  }
  private loadRegistry(day: string, names = this.names): Promise<void> {
    const existing = this.registryFlights.get(day);
    if (existing) return existing;
    const flight = this.readRegistry(day, names).finally(() => this.registryFlights.delete(day));
    this.registryFlights.set(day, flight);
    return flight;
  }
  private async readRegistry(day: string, names: string[]) {
    const date = day.replaceAll('-', '');
    for (const name of this.registries.keys())
      if (REGISTRY_RE.exec(name)?.[1] === date && !names.includes(name)) this.registries.delete(name);
    for (const name of names.filter((x) => REGISTRY_RE.exec(x)?.[1] === date)) {
      let target = this.registries.get(name);
      if (!target) {
        target = { ino: 0, offset: 0, errors: 0, rows: new Map(), modified: 0, size: 0 };
        this.registries.set(name, target);
      }
      const entry = target;
      try {
        const st = await stat(join(this.root, name));
        if (st.ino === entry.ino && st.mtimeMs === entry.modified && st.size === entry.size) continue;
        if (st.ino === entry.ino && (st.size < entry.size || (st.size === entry.size && st.mtimeMs !== entry.modified)))
          entry.ino = 0;
        await tail(
          join(this.root, name),
          entry,
          (o) => {
            const ts = Date.parse(o.ts);
            if (!Number.isInteger(o.pid) || !Number.isFinite(ts)) return;
            const row: RegistryEntry = {
              pid: o.pid,
              pp: n(o.pp),
              start: String(o.start ?? ''),
              ts,
              argv: redact(String(o.argv ?? '')).slice(0, 2000),
              name: String(o.name ?? ''),
            };
            const rows = entry.rows.get(o.pid) ?? [];
            rows.push(row);
            entry.rows.set(o.pid, rows);
          },
          () => entry.rows.clear(),
        );
        entry.modified = st.mtimeMs;
        entry.size = st.size;
      } catch (e) {
        this.issues.push(String(e));
      }
    }
  }
  private registry(
    day: string,
    pid: number,
    epoch: number,
    identity?: string,
    files = this.registries,
  ): RegistryEntry | undefined {
    // Merge all shards at lookup time; each shard owns its inode, cursor and rows.
    let best: RegistryEntry | undefined;
    for (const [name, file] of files) {
      if (REGISTRY_RE.exec(name)?.[1] !== day.replaceAll('-', '')) continue;
      for (const row of file.rows.get(pid) ?? []) {
        if (identity && `${pid}:${row.start || row.ts}` !== identity) continue;
        if (row.ts <= epoch && (!best || row.ts > best.ts)) best = row;
      }
    }
    return best;
  }
  private record(
    raw: any,
    day: string,
    epoch: number,
    warmup: boolean,
    schema = 1,
    registries = this.registries,
  ): ProcessRecord {
    const explicitIdentity = raw.start == null || raw.start === '' ? undefined : `${n(raw.pid)}:${raw.start}`;
    const reg = this.registry(day, n(raw.pid), epoch, explicitIdentity, registries);
    const name = String(raw.n ?? reg?.name ?? '?').slice(0, 100);
    return {
      pid: n(raw.pid),
      pp: n(raw.pp),
      n: name,
      fp: n(raw.fp),
      rss: n(raw.rss),
      fpd: n(raw.fpd),
      cpu: warmup || schema < 2 ? null : numberOrNull(raw.cpu),
      readMBs: schema >= 2 ? numberOrNull(raw.read_mb_s) : null,
      writeMBs: schema >= 2 ? numberOrNull(raw.write_mb_s) : null,
      th: numberOrNull(raw.th),
      rt: numberOrNull(raw.rt),
      fd: numberOrNull(raw.fd),
      ni: numberOrNull(raw.ni),
      pi: numberOrNull(raw.pi),
      imx: schema >= 2 ? numberOrNull(raw.imx) : null,
      group: groupFor(name, reg?.argv ?? raw.argv ?? ''),
      identity: explicitIdentity ?? `${n(raw.pid)}:${reg?.start || reg?.ts || day}`,
    };
  }
  private sample(o: any, day: string): Sample | null {
    const epoch = Date.parse(o.ts);
    if (!Number.isFinite(epoch)) return null;
    const warmup = n(o.dt) < 10;
    const rows = Array.isArray(o.full) ? o.full : o.procs;
    const agg = o.agg ?? {};
    return {
      ts: new Date(epoch).toISOString(),
      epoch,
      dt: n(o.dt),
      source: 'resource',
      sys: systemState(o.sys),
      agg: {
        count: n(agg.count),
        footprint_mb: n(agg.footprint_mb),
        cpu_pct: warmup || n(o.schema) < 2 ? null : numberOrNull(agg.cpu_pct),
        threads: n(agg.threads),
        ...(numberOrNull(agg.seen_count) !== null ? { seen_count: n(agg.seen_count) } : {}),
        ...(numberOrNull(agg.denied_or_exited) !== null ? { denied_or_exited: n(agg.denied_or_exited) } : {}),
      },
      procs: rows.map((r: any) => this.record(r, day, epoch, warmup, n(o.schema))),
      fullCount: Array.isArray(o.full) ? o.full.length : null,
    };
  }
  private point(s: Sample): TrendPoint {
    return {
      ts: s.epoch,
      swapMb: s.sys.swap_used_mb,
      swapTotalMb: s.sys.swap_total_mb,
      freeMb: s.sys.free_mb,
      compressorMb: s.sys.compressor_mb,
      wiredMb: s.sys.wired_mb,
      pressure: s.sys.pressure,
      swapIn: s.sys.swapin_mb_s,
      swapOut: s.sys.swapout_mb_s,
      diskMBs: s.sys.disk?.mb_s ?? null,
      diskTps: s.sys.disk?.tps ?? null,
      load: s.sys.load[0] ?? null,
      processCpu: s.agg.cpu_pct,
      processCount: s.agg.count,
      uptime: s.sys.uptime_h,
      hostCpuPct: s.sys.cpu_pct ?? null,
      gpuPct: null,
      reboot: false,
      gap: false,
    };
  }
  async days() {
    await this.refresh();
    return [
      ...new Set(
        this.names.flatMap((x) => {
          const match = RESOURCE_RE.exec(x) ?? CPU_RE.exec(x);
          return match ? [isoDay(match[1])] : [];
        }),
      ),
    ]
      .sort()
      .reverse();
  }
  async view(day: string, range: Range) {
    await this.refresh(day);
    const hours = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 }[range];
    const daySamples = [...this.files.values(), ...this.cpuFiles.values()]
      .map((f) => f.latest)
      .filter((s): s is Sample => s !== null && localDay(new Date(s.epoch)) === day);
    const end =
      day === localDay()
        ? Date.now()
        : Math.max(...daySamples.map((s) => s.epoch), new Date(`${day}T00:00:00`).getTime());
    const start = Math.max(range === '7d' ? 0 : new Date(`${day}T00:00:00`).getTime(), end - hours * 3600000);
    const resourcePoints = [...this.files.values()].flatMap((f) => f.points);
    const legacyPoints = [...this.cpuFiles.values()].flatMap((f) => f.points);
    // Prefer structured samples; merge GPU from a nearby independent MEM line only (never interpolate across large gaps).
    const legacySorted = legacyPoints.sort((a, b) => a.ts - b.ts);
    let nearest = 0;
    const enriched = resourcePoints
      .sort((a, b) => a.ts - b.ts)
      .map((p) => {
        while (
          nearest + 1 < legacySorted.length &&
          Math.abs(legacySorted[nearest + 1].ts - p.ts) <= Math.abs(legacySorted[nearest].ts - p.ts)
        )
          nearest++;
        const near = legacySorted[nearest];
        return near && Math.abs(near.ts - p.ts) <= 90000 ? { ...p, gpuPct: near.gpuPct } : p;
      });
    // MEM samples also fill interruptions after structured collection has started.
    let resourceIndex = 0;
    const fallback = legacySorted.filter((p) => {
      while (
        resourceIndex + 1 < enriched.length &&
        Math.abs(enriched[resourceIndex + 1].ts - p.ts) <= Math.abs(enriched[resourceIndex].ts - p.ts)
      )
        resourceIndex++;
      return !enriched[resourceIndex] || Math.abs(enriched[resourceIndex].ts - p.ts) > 90000;
    });
    const all = [...enriched, ...fallback].sort((a, b) => a.ts - b.ts);
    const unique = all.filter((x, i) => i === 0 || x.ts !== all[i - 1].ts);
    const boots: number[] = [];
    for (const p of resourcePoints) {
      if (p.uptime === null) continue;
      const boot = p.ts - p.uptime * 3600000;
      if (!boots.some((x) => Math.abs(x - boot) < 90000)) boots.push(boot);
    }
    let previous: TrendPoint | null = null;
    const points: TrendPoint[] = [];
    for (const p of unique) {
      const bootAt = p.uptime == null ? null : p.ts - p.uptime * 3600000;
      const reboot =
        previous != null &&
        ((p.uptime != null &&
          (previous.uptime != null
            ? p.uptime < previous.uptime - 0.02
            : bootAt != null && previous.ts < bootAt - 60000)) ||
          boots.some((boot) => boot > previous!.ts && boot <= p.ts));
      const gap = previous != null && p.ts - previous.ts > 150000;
      if (p.ts >= start && p.ts <= end) points.push({ ...p, reboot, gap });
      previous = p;
    }
    const freshest = daySamples.sort((a, b) => b.epoch - a.epoch)[0] ?? null;
    const structuredLatest = daySamples.filter((s) => s.source === 'resource').sort((a, b) => b.epoch - a.epoch)[0];
    // Independent MEM is often a few seconds newer; do not discard an otherwise fresh process snapshot.
    const latest =
      structuredLatest && freshest && freshest.epoch - structuredLatest.epoch <= 90000 ? structuredLatest : freshest;
    const overall = [...this.files.values()]
      .map((f) => f.latest)
      .filter((s): s is Sample => s !== null)
      .sort((a, b) => b.epoch - a.epoch)[0];
    // Peak-preserving buckets: retain the largest swap I/O, footprint pressure, load or throughput in each bucket.
    const history = downsample(points, 720);
    return {
      latest,
      latestOverallAt: overall?.ts ?? null,
      history,
      sampleCount: points.length,
      windowStart: start,
      windowEnd: end,
      parseErrors: [...this.files.values()].reduce((sum, f) => sum + f.errors, 0),
      issues: this.issues,
      from: points[0] ? new Date(points[0].ts).toISOString() : null,
      to: points.at(-1) ? new Date(points.at(-1)!.ts).toISOString() : null,
    };
  }
  process(day: string, pid: number, identity?: string): Promise<ProcessDetail | null> {
    const key = JSON.stringify([day, pid, identity ?? null]);
    const existing = this.processFlights.get(key);
    if (existing) return existing;
    const flight = this.loadProcess(key, day, pid, identity).finally(() => this.processFlights.delete(key));
    this.processFlights.set(key, flight);
    return flight;
  }
  private async loadProcess(key: string, day: string, pid: number, identity?: string): Promise<ProcessDetail | null> {
    await this.refresh(day);
    // Directory/stat checks are cheap and detect rotations even inside the overview's refresh interval.
    const names = await readdir(this.root).catch(() => [] as string[]);
    await this.loadRegistry(day, names);
    const registries = new Map(
      [...this.registries].filter(([name]) => REGISTRY_RE.exec(name)?.[1] === day.replaceAll('-', '')),
    );
    const query: ProcessQuery = this.processQueries.get(key) ?? { files: new Map(), signature: '', result: null };
    // Move hits to the end; only eight query keys retain per-PID observations.
    this.processQueries.delete(key);
    this.processQueries.set(key, query);
    while (this.processQueries.size > 8) this.processQueries.delete(this.processQueries.keys().next().value!);
    const files = names.filter((x) => RESOURCE_RE.exec(x)?.[1] === day.replaceAll('-', '')).sort();
    const sources = await Promise.all(
      files.map(async (name) => ({ name, st: await stat(join(this.root, name)).catch(() => null) })),
    );
    const registrySignature = [...registries]
      .map(([name, f]) => `${name}:${f.ino}:${f.offset}:${f.modified}`)
      .sort()
      .join('|');
    const signature =
      sources.map(({ name, st }) => `${name}:${st?.ino}:${st?.size}:${st?.mtimeMs}`).join('|') +
      '#' +
      registrySignature;
    if (signature === query.signature) return query.result;
    const live = new Set(sources.filter((x) => x.st).map((x) => x.name));
    for (const name of query.files.keys()) if (!live.has(name)) query.files.delete(name);
    for (const { name, st } of sources) {
      if (!st) continue;
      let file = query.files.get(name);
      if (!file) {
        file = { ino: 0, offset: 0, errors: 0, rows: [], modified: 0, size: 0 };
        query.files.set(name, file);
      }
      if (st.ino === file.ino && st.size === file.size && st.mtimeMs === file.modified) continue;
      if (st.ino === file.ino && (st.size < file.size || (st.size === file.size && st.mtimeMs !== file.modified)))
        file.ino = 0;
      const target = file;
      await tail(
        join(this.root, name),
        target,
        (o) => {
          if (o.k !== 'sample' || !Array.isArray(o.procs)) return;
          const ts = Date.parse(o.ts);
          const raw = (Array.isArray(o.full) ? o.full : o.procs).find((x: any) => x.pid === pid);
          if (raw && Number.isFinite(ts)) target.rows.push({ ts, raw, warmup: n(o.dt) < 10, schema: n(o.schema) });
        },
        () => {
          target.rows = [];
        },
      );
      file.modified = st.mtimeMs;
      file.size = st.size;
    }
    // Resolve cached raw rows again when the registry changes, without reparsing sample files.
    const rows = [...query.files.values()].flatMap((f) =>
      f.rows.map((o) => ({ ts: o.ts, record: this.record(o.raw, day, o.ts, o.warmup, o.schema, registries) })),
    );
    let latest: ProcessRecord | null = null;
    let epoch = -Infinity;
    for (const row of rows)
      if ((!identity || row.record.identity === identity) && row.ts > epoch) {
        latest = row.record;
        epoch = row.ts;
      }
    if (!latest) {
      query.signature = signature;
      query.result = null;
      return null;
    }
    const generation = identity ?? latest.identity;
    const unique = new Map<number, ProcessDetail['history'][number]>();
    for (const { ts, record: r } of rows)
      if (r.identity === generation) unique.set(ts, { ts, fp: r.fp, rss: r.rss, cpu: r.cpu, growth: r.fpd });
    const history = [...unique.values()].sort((a, b) => a.ts - b.ts);
    const reg = this.registry(day, pid, epoch, generation, registries);
    const parent = this.registry(day, latest.pp, epoch, undefined, registries);
    query.signature = signature;
    query.result = {
      process: latest,
      command: reg?.argv ?? null,
      start: reg ? new Date(reg.ts).toISOString() : null,
      parent: latest.pp ? { pid: latest.pp, name: parent?.name ?? '未记录名称' } : null,
      history,
      note: '首次登记时间不等于进程启动时间。曲线仅含该进程已记录的采样；CPU 100% 表示一个核心。footprint 含压缩等物理占用，RSS 可能含共享页，均不能直接相加为整机用量。',
    };
    return query.result;
  }
  groups(sample: Sample | null): GroupSummary[] {
    const map = new Map<string, GroupSummary>();
    for (const p of sample?.procs ?? []) {
      let row = map.get(p.group);
      if (!row) {
        row = { name: p.group, count: 0, footprintMb: 0, rssMb: 0, growthMb: 0, cpuPct: null };
        map.set(p.group, row);
      }
      row.count++;
      row.footprintMb += p.fp;
      row.rssMb += p.rss;
      row.growthMb += p.fpd;
      if (p.cpu !== null) row.cpuPct = (row.cpuPct ?? 0) + p.cpu;
    }
    return [...map.values()].sort((a, b) => b.footprintMb - a.footprintMb);
  }
  async incidents(day?: string, window?: { start: number; end: number }): Promise<IncidentSummary[]> {
    const root = join(this.root, 'incidents');
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return [];
    }
    const rows: IncidentSummary[] = [];
    const candidates = names
      .filter((x) => /^\d{8}-\d{6}\.json$/.test(x))
      .sort()
      .reverse()
      .filter((name) => {
        if (day && !name.startsWith(day.replaceAll('-', ''))) return false;
        const id = name.slice(0, -5);
        const epoch = Date.parse(
          `${isoDay(id.slice(0, 8))}T${id.slice(9, 11)}:${id.slice(11, 13)}:${id.slice(13, 15)}`,
        );
        return !window || (epoch >= window.start && epoch <= window.end);
      })
      .slice(0, 300);
    for (const name of candidates) {
      const id = name.slice(0, -5);
      if (day && !id.startsWith(day.replaceAll('-', ''))) continue;
      try {
        const file = Bun.file(join(root, name));
        if (file.size > 2 * 1024 * 1024) continue;
        const o = await file.json();
        const artifacts = names.filter((x) => x.startsWith(`${id}.`) && x !== name);
        const ts = `${isoDay(id.slice(0, 8))}T${id.slice(9, 11)}:${id.slice(11, 13)}:${id.slice(13, 15)}`;
        const sys = systemState(o.system);
        const critical = sys.pressure === 4 || (sys.swapin_mb_s ?? 0) >= 8 || (sys.swapout_mb_s ?? 0) >= 8;
        rows.push({
          id,
          ts: new Date(ts).toISOString(),
          reason: String(o.reason ?? ''),
          health: critical ? 'critical' : 'warning',
          artifactCount: artifacts.length,
          hasFileTrace: artifacts.some((x) => x.includes('.fs_usage')),
        });
      } catch {
        /* Removed/partial incident: retry next request. */
      }
    }
    return rows;
  }
  async incident(id: string): Promise<IncidentDetail | null> {
    if (!INCIDENT_RE.test(id)) return null;
    const summary = (await this.incidents(isoDay(id.slice(0, 8)))).find((x) => x.id === id);
    if (!summary) return null;
    const root = join(this.root, 'incidents');
    const file = Bun.file(join(root, `${id}.json`));
    const o = await file.json();
    const day = isoDay(id.slice(0, 8));
    const epoch = Date.parse(summary.ts);
    const names = (await readdir(root)).filter((x) => x.startsWith(`${id}.`) && x !== `${id}.json`);
    const artifacts = [];
    for (const name of names) {
      const st = await stat(join(root, name)).catch(() => null);
      if (st?.isFile())
        artifacts.push({
          name,
          size: st.size,
          kind: name.includes('fs_usage')
            ? '文件路径追踪'
            : name.includes('sample-')
              ? '线程采样'
              : name.includes('vmmap-')
                ? '内存映射'
                : name.includes('lsof-')
                  ? '打开的文件'
                  : '现场文件',
        });
    }
    const rows = (v: unknown) => (Array.isArray(v) ? v.map((r) => this.record(r, day, epoch, false, n(o.schema))) : []);
    return {
      ...summary,
      system: systemState(o.system),
      topGrowth: rows(o.top_growth),
      topMemory: rows(o.top_footprint),
      topCpu: rows(o.top_cpu),
      topWrite: rows(o.top_write),
      processTree: redact(String(o.ps ?? '')).slice(0, 200000),
      artifacts,
    };
  }
  async artifact(id: string, name: string): Promise<ArtifactContent | null> {
    if (!INCIDENT_RE.test(id) || !name.startsWith(`${id}.`) || basename(name) !== name || /[\\\x00]/.test(name))
      return null;
    const root = await realpath(join(this.root, 'incidents')).catch(() => null);
    if (!root) return null;
    const path = await realpath(resolve(root, name)).catch(() => null);
    if (!path || !path.startsWith(root + sep)) return null;
    const st = await stat(path);
    if (!st.isFile()) return null;
    const file = await open(path, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, 256 * 1024));
      const { bytesRead } = await file.read(buf, 0, buf.length, 0);
      return {
        name,
        content: redact(buf.subarray(0, bytesRead).toString('utf8')),
        truncated: st.size > bytesRead,
        size: st.size,
      };
    } finally {
      await file.close();
    }
  }
  async cpuWatcherLastSeen(): Promise<string | null> {
    const names = this.names
      .filter((x) => /^cpu-\d{8}\.log(?:\.\d+)?$/.test(x))
      .sort()
      .reverse()
      .slice(0, 8);
    let latest = 0;
    for (const name of names) {
      const st = await stat(join(this.root, name)).catch(() => null);
      if (st) latest = Math.max(latest, st.mtimeMs);
    }
    return latest ? new Date(latest).toISOString() : null;
  }
  async rootInstalled() {
    return exists('/Library/LaunchDaemons/com.qirong.mica-perf-capture.plist');
  }
}

export function downsample(points: TrendPoint[], buckets: number): TrendPoint[] {
  if (points.length <= buckets) return points;
  const out: TrendPoint[] = [];
  const width = Math.ceil(points.length / Math.max(1, Math.floor(buckets / 4)));
  for (let i = 0; i < points.length; i += width) {
    const group = points.slice(i, i + width);
    const selected = new Set([group[0], group.at(-1)!]);
    // Keep peaks of each distinct signal, plus every discontinuity. Do not average away pre-crash spikes.
    for (const key of ['swapMb', 'swapIn', 'swapOut', 'diskMBs', 'load', 'pressure'] as const) {
      const peak = group.reduce((a, b) => ((b[key] ?? -Infinity) > (a[key] ?? -Infinity) ? b : a));
      selected.add(peak);
    }
    for (const p of group) if (p.reboot || p.gap) selected.add(p);
    out.push(...[...selected].sort((a, b) => a.ts - b.ts));
  }
  return out;
}
