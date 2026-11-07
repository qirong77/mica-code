import { cpus, hostname, platform, totalmem, uptime } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { TelemetryStore, localDay, validDay } from './store';
import { MicaStore, micaProcessRows } from './mica';
import type { CollectorStatus, Health, Overview, Range } from '../shared/types';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.MICA_PERF_LOG_DIR || join(homedir(), 'Library/Logs/cpu-watch');
const port = Number(process.env.MICA_PERF_PORT || 9316);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('MICA_PERF_PORT 必须是 1024–65535');
const store = new TelemetryStore(root);
const mica = new MicaStore();
const cores = cpus();
const host = {
  name: hostname(),
  platform: platform(),
  cpuModel: cores[0]?.model ?? 'Unknown',
  cpuCores: cores.length,
  memoryMb: totalmem() / 1048576,
};
let lastCpu = cpus();
let liveCpuPct: number | null = null;
setInterval(() => {
  const next = cpus();
  let idle = 0,
    sum = 0;
  next.forEach((c, i) => {
    const p = lastCpu[i];
    if (!p) return;
    idle += c.times.idle - p.times.idle;
    for (const key of ['user', 'nice', 'sys', 'idle', 'irq'] as const) sum += c.times[key] - p.times[key];
  });
  liveCpuPct = sum > 0 ? Math.max(0, Math.min(100, ((sum - idle) / sum) * 100)) : null;
  lastCpu = next;
}, 2000).unref();

const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
const error = (message: string, status = 400) => json({ error: message }, status);
function getDay(url: URL, fallback: string) {
  const v = url.searchParams.get('day') || fallback;
  if (!validDay(v)) throw new Error('日期格式无效，使用 YYYY-MM-DD');
  return v;
}
function getRange(url: URL): Range {
  const range = (url.searchParams.get('range') ?? '6h') as Range;
  if (!['1h', '6h', '24h', '7d'].includes(range)) throw new Error('不支持的时间范围');
  return range;
}
/** 从资源采集的最后一份快照里挑出 Mica 进程，并补上完整命令行用于归属。 */
async function micaProcessContext(day: string) {
  const snapshot = await store.latestSnapshot(day);
  const procs = snapshot?.procs ?? [];
  return micaProcessRows(procs, snapshot?.commands ?? new Map(), snapshot?.at ?? null);
}
const launchCache = new Map<string, { ts: number; state: string | null }>();
async function launchState(label: string): Promise<string | null> {
  const prev = launchCache.get(label);
  if (prev && Date.now() - prev.ts < 30000) return prev.state;
  let state: string | null = null;
  try {
    const p = Bun.spawn(['/bin/launchctl', 'print', label], { stdout: 'pipe', stderr: 'ignore' });
    const timer = setTimeout(() => p.kill(), 1500);
    try {
      const text = await new Response(p.stdout).text();
      await p.exited;
      state = /\bstate = (\w+)/.exec(text)?.[1] ?? null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    /* launchd absent or permission denied */
  }
  launchCache.set(label, { ts: Date.now(), state });
  return state;
}
async function collectorStatuses(latest: string | null): Promise<CollectorStatus[]> {
  const [cpuAt, rootInstalled, captureState, lcaState] = await Promise.all([
    store.cpuWatcherLastSeen(),
    store.rootInstalled(),
    launchState('system/com.qirong.mica-perf-capture'),
    launchState('system/com.qirong.lca-tame'),
  ]);
  const age = (v: string | null) => (v ? (Date.now() - Date.parse(v)) / 1000 : Infinity);
  return [
    {
      id: 'resource',
      name: '进程与系统资源',
      state: latest ? (age(latest) < 180 ? 'running' : 'stale') : 'unavailable',
      detail: '每 60 秒采样；按权限记录进程 footprint、RSS、CPU、线程与句柄。',
      lastSeen: latest,
    },
    {
      id: 'cpu',
      name: 'CPU 尖峰与进程树',
      state: cpuAt ? (age(cpuAt) < 180 ? 'running' : 'stale') : 'unavailable',
      detail: '独立 4 秒采样器，保存尖峰及祖先链；mtime 只表示日志有更新。',
      lastSeen: cpuAt,
    },
    {
      id: 'capture',
      name: '文件写入路径抓取',
      state: captureState === 'running' ? 'running' : rootInstalled ? 'unavailable' : 'not-installed',
      detail:
        captureState === 'running'
          ? 'root 捕获器已运行；仅异常触发时抓取，不保证每次都有现场。'
          : rootInstalled
            ? '已发现安装文件，但无法确认进程运行；请检查服务。'
            : 'root 捕获器尚未安装；可读进程有 I/O 字节，具体写入路径仍无法归属。',
      lastSeen: null,
    },
    {
      id: 'lca',
      name: 'LCA 限制守护进程',
      state: lcaState === 'running' ? 'running' : 'unavailable',
      detail: '仅检查 launchd 运行状态；CPU 用量见进程表，具体占空比需独立自检。',
      lastSeen: null,
    },
  ];
}
async function overview(url: URL): Promise<Overview> {
  const days = await store.days();
  const day = getDay(url, days[0] ?? localDay());
  const range = getRange(url);
  const v = await store.view(day, range);
  const latest = v.latest;
  const ageSeconds = latest ? Math.max(0, (Date.now() - latest.epoch) / 1000) : null;
  const findings: Overview['findings'] = [];
  let health: Health = 'ok';
  const add = (level: Health, title: string, detail: string) => {
    findings.push({ level, title, detail });
    if (level === 'critical' || (level === 'warning' && health !== 'critical')) health = level;
  };
  if (!latest) {
    health = 'unknown';
    add('unknown', '没有资源采样', '选择有数据的日期，或检查资源采集器是否运行。');
  } else {
    const s = latest.sys;
    if (s.pressure === 4) add('critical', '系统报告严重内存压力', '需要结合进程增长与换页速率判断来源。');
    else if (s.pressure === 2)
      add('warning', '系统报告内存压力警告', '查看进程 footprint 增长；高占用本身不能证明内存泄漏。');
    if ((s.swapin_mb_s ?? 0) >= 8 || (s.swapout_mb_s ?? 0) >= 8)
      add(
        'critical',
        '当前采样存在大量换页',
        `换入 ${s.swapin_mb_s ?? '—'} MB/s · 换出 ${s.swapout_mb_s ?? '—'} MB/s；与进程增长和磁盘吞吐对照。`,
      );
    if ((s.disk_free_gb ?? Infinity) < 15) add('warning', '磁盘剩余空间不足 15 GB', '空间不足会影响 swap 与文件写入。');
    if ((s.load[0] ?? 0) > host.cpuCores * 1.5)
      add('warning', '系统负载偏高', 'load 不是 CPU 百分比，需结合等待与换页数据解释。');
    const swapPct = s.swap_total_mb ? ((s.swap_used_mb ?? 0) / s.swap_total_mb) * 100 : 0;
    if (swapPct >= 85 && !findings.some((x) => /内存|换页/.test(x.title)))
      add('warning', '已分配 swap 使用较高', 'swap 总量由 macOS 动态扩容；该比例不能单独证明卡顿或容量耗尽。');
    if (day === localDay() && (ageSeconds ?? Infinity) > 180) {
      health = 'unknown';
      add('unknown', '采样已过期', '页面保留最后一条数据；不代表当前主机状态。');
    }
    if (!findings.length) add('ok', '本次采样未触发压力阈值', '这是采样时刻的状态，不能排除两次采样间的瞬时异常。');
  }
  const collectors = await collectorStatuses(v.latestOverallAt);
  const warnings = [
    '常驻采样周期 60 秒；进程记录采用阈值筛选，每 30 分钟保存全量。归类汇总仅覆盖本次记录的进程。',
    'footprint / RSS 含共享或压缩等记账，应用合计不等于物理内存已用量；CPU 100% 表示一个核心。',
    'V2 采集器通过 rusage V4 记录可读取进程的 I/O，无法读取的系统进程仍缺失；旧 CPU 单位有误，已隐藏旧数值。',
    '打开文件清单仅表示句柄存在，不能证明该文件正被写入。内核 interval 峰值不等于网页选定时间段内的峰值。',
    ...v.issues,
  ];
  if (latest?.source === 'cpu-text')
    warnings.unshift('该日期仅有旧 CPU/MEM 日志：无逐进程内存、磁盘吞吐与压力等级；未知字段保持空值。');
  if (range === '7d' && days.length < 7)
    warnings.push(`资源日志目前仅覆盖 ${days.length} 天；更早的 CPU 文本日志没有完整进程内存数据。`);
  if (collectors.find((c) => c.id === 'capture')?.state !== 'running')
    warnings.push('root 文件路径捕获器未确认运行，写盘归因仍存在缺口。');
  return {
    generatedAt: new Date().toISOString(),
    day,
    range,
    host: { ...host, uptimeSeconds: uptime() },
    liveCpuPct,
    latest,
    latestOverallAt: v.latestOverallAt,
    ageSeconds,
    health,
    findings,
    history: v.history,
    groups: store.groups(latest),
    incidents: await store.incidents(undefined, { start: v.windowStart, end: v.windowEnd }),
    collectors,
    coverage: {
      sampleCount: v.sampleCount,
      processCount: latest?.agg.count ?? 0,
      recordedCount: latest?.procs.length ?? 0,
      parseErrors: v.parseErrors,
      warnings,
      from: v.from,
      to: v.to,
    },
  };
}

const webRoot = join(appRoot, 'dist');
export const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  idleTimeout: 30,
  async fetch(req) {
    const url = new URL(req.url);
    // Local telemetry contains process arguments and file paths. Reject cross-site reads and DNS rebinding.
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return error('仅允许本机访问', 403);
    const origin = req.headers.get('origin');
    if (
      origin &&
      ![
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        'http://127.0.0.1:5178',
        'http://localhost:5178',
      ].includes(origin)
    )
      return error('不允许跨站访问', 403);
    if (req.headers.get('sec-fetch-site') === 'cross-site') return error('不允许跨站访问', 403);
    if (req.method !== 'GET' && req.method !== 'HEAD') return error('只读接口', 405);
    try {
      if (url.pathname === '/api/health')
        return json({ ok: true, service: 'mica-perf-monitor', now: new Date().toISOString() });
      if (url.pathname === '/api/days') {
        const days = await store.days();
        return json({ days, latestDay: days[0] ?? null });
      }
      if (url.pathname === '/api/overview') return json(await overview(url));
      if (url.pathname === '/api/mica') {
        // 没有显式日期时才去扫资源日志目录；否则每次请求都会触发一次全历史解析。
        const day = url.searchParams.get('day')
          ? getDay(url, localDay())
          : ((await store.days())[0] ?? localDay());
        return json(await mica.overview(day, getRange(url), await micaProcessContext(day)));
      }
      const procMatch = /^\/api\/processes\/(\d+)$/.exec(url.pathname);
      if (procMatch) {
        const day = getDay(url, localDay());
        const pid = Number(procMatch[1]);
        if (!Number.isSafeInteger(pid) || pid < 1 || pid > 1000000) return error('PID 无效');
        const row = await store.process(day, pid, url.searchParams.get('identity') ?? undefined);
        return row ? json(row) : error('该进程在选定日期没有记录', 404);
      }
      const incidentMatch = /^\/api\/incidents\/(\d{8}-\d{6})$/.exec(url.pathname);
      if (incidentMatch) {
        const row = await store.incident(incidentMatch[1]);
        return row ? json(row) : error('异常现场不存在', 404);
      }
      const artifactMatch = /^\/api\/incidents\/(\d{8}-\d{6})\/artifacts\/([^/]+)$/.exec(url.pathname);
      if (artifactMatch) {
        const row = await store.artifact(artifactMatch[1], decodeURIComponent(artifactMatch[2]));
        return row ? json(row) : error('现场文件不存在', 404);
      }
      if (url.pathname.startsWith('/api/')) return error('接口不存在', 404);
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      let path = resolve(webRoot, relative || 'index.html');
      if (!path.startsWith(webRoot + sep)) return error('路径无效', 400);
      const real = await realpath(path).catch(() => null);
      if (real && !real.startsWith(webRoot + sep)) return error('路径无效', 400);
      let file = Bun.file(path);
      if (!(await file.exists())) {
        if (extname(relative)) return error('文件不存在', 404);
        path = join(webRoot, 'index.html');
        file = Bun.file(path);
      }
      if (!(await file.exists())) return error('前端尚未构建，请在 apps/perf-monitor 运行 npm run build', 503);
      return new Response(req.method === 'HEAD' ? null : file, {
        headers: {
          'Content-Type': file.type,
          'Cache-Control': path.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
        },
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/日期|时间范围|URI malformed/.test(message)) return error(message);
      console.error('[perf-monitor]', message);
      return error('读取采集数据失败，请检查采集目录权限或服务日志。', 500);
    }
  },
});
console.log(`Mica performance monitor: http://127.0.0.1:${server.port}`);
console.log(`Telemetry: ${root} (read-only)`);
