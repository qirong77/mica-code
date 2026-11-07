export type Range = '1h' | '6h' | '24h' | '7d';
export type Health = 'ok' | 'warning' | 'critical' | 'unknown';
export interface ProcessRecord {
  pid: number;
  pp: number;
  n: string;
  fp: number;
  rss: number;
  fpd: number;
  cpu: number | null;
  th: number | null;
  rt: number | null;
  fd: number | null;
  ni: number | null;
  pi: number | null;
  imx: number | null;
  group: string;
  identity: string; // identity includes PID generation when available
  readMBs?: number | null;
  writeMBs?: number | null;
}
export interface SystemState {
  cpu_pct?: number | null;
  swap_used_mb: number | null;
  swap_total_mb: number | null;
  free_mb: number | null;
  compressor_mb: number | null;
  wired_mb: number | null;
  pressure: number | null;
  disk_free_gb: number | null;
  disk_used_pct: number | null;
  uptime_h: number | null;
  swapin_mb_s: number | null;
  swapout_mb_s: number | null;
  thrashing_detected: number | null;
  disk: { mb_s: number; tps: number; kb_per_transfer: number } | null;
  load: number[];
}
export interface Sample {
  ts: string;
  epoch: number;
  dt: number;
  sys: SystemState;
  source?: 'resource' | 'cpu-text';
  agg: {
    count: number;
    footprint_mb: number;
    cpu_pct: number | null;
    threads: number;
    seen_count?: number;
    denied_or_exited?: number;
  };
  procs: ProcessRecord[];
  fullCount: number | null;
}
export interface TrendPoint {
  ts: number;
  swapMb: number | null;
  swapTotalMb: number | null;
  freeMb: number | null;
  compressorMb: number | null;
  wiredMb: number | null;
  pressure: number | null;
  swapIn: number | null;
  swapOut: number | null;
  diskMBs: number | null;
  diskTps: number | null;
  load: number | null;
  processCpu: number | null;
  processCount: number;
  uptime: number | null;
  gpuPct: number | null;
  reboot: boolean;
  gap: boolean;
  hostCpuPct?: number | null;
}
export interface GroupSummary {
  name: string;
  count: number;
  footprintMb: number;
  rssMb: number;
  growthMb: number;
  cpuPct: number | null;
}
export interface IncidentSummary {
  id: string;
  ts: string;
  reason: string;
  health: Health;
  artifactCount: number;
  hasFileTrace: boolean;
}
export interface CollectorStatus {
  id: string;
  name: string;
  state: 'running' | 'stale' | 'unavailable' | 'not-installed';
  detail: string;
  lastSeen: string | null;
}
export interface Overview {
  generatedAt: string;
  day: string;
  range: Range;
  host: { name: string; platform: string; cpuModel: string; cpuCores: number; memoryMb: number; uptimeSeconds: number };
  liveCpuPct: number | null; // OS counter delta, current host, not historical
  latest: Sample | null;
  latestOverallAt: string | null;
  ageSeconds: number | null;
  health: Health;
  findings: { level: Health; title: string; detail: string }[];
  history: TrendPoint[];
  groups: GroupSummary[];
  incidents: IncidentSummary[];
  collectors: CollectorStatus[];
  coverage: {
    sampleCount: number;
    processCount: number;
    recordedCount: number;
    parseErrors: number;
    warnings: string[];
    from: string | null;
    to: string | null;
  };
}
export interface DaysResponse {
  days: string[];
  latestDay: string | null;
}
export interface ProcessDetail {
  process: ProcessRecord;
  command: string | null;
  start: string | null;
  parent: { pid: number; name: string } | null;
  history: { ts: number; fp: number; rss: number; cpu: number | null; growth: number }[];
  note: string;
}
export interface Artifact {
  name: string;
  size: number;
  kind: string;
}
export interface IncidentDetail extends IncidentSummary {
  system: SystemState;
  topGrowth: ProcessRecord[];
  topMemory: ProcessRecord[];
  topCpu: ProcessRecord[];
  processTree: string;
  artifacts: Artifact[];
  topWrite?: ProcessRecord[];
}
export interface ArtifactContent {
  name: string;
  content: string;
  truncated: boolean;
  size: number;
}

/** Mica 自身监控：进程构成、宿主内存、渲染与调用耗时（数据来自 Mica 诊断日志与资源采集）。 */
export interface MicaProcessInfo {
  pid: number;
  ppid: number;
  kind: string;
  name: string;
  footprintMb: number;
  rssMb: number;
  growthMb: number | null;
  cpuPct: number | null;
  threads: number | null;
  command: string | null;
  session: string | null;
  orphan: boolean;
}
export interface MicaProcessKind {
  kind: string;
  count: number;
  footprintMb: number;
  rssMb: number;
  cpuPct: number | null;
  processes: MicaProcessInfo[];
}
export interface MicaHostUsage {
  pid: number;
  host: string;
  rssMb: number;
  lastAt: string;
  firstRssMb: number | null;
  growthMb: number | null;
  session: string | null;
  turn: string | null;
  model: string | null;
  windows: number | null;
  hosts: number | null;
  busy: number | null;
  byType: Record<string, number> | null;
  samples: number;
}
export interface MicaMemoryPoint {
  ts: number;
  main: number | null;
  runtime: number | null;
  appServer: number | null;
  tui: number | null;
  gpu: number | null;
  tab: number | null;
  utility: number | null;
}
export interface MicaPageStat {
  pageId: string;
  sid: string | null;
  samples: number;
  lastAt: string;
  heapMb: number | null;
  heapMaxMb: number | null;
  heapFirstMb: number | null;
  dom: number | null;
  rows: number | null;
}
export interface MicaChannelStat {
  channel: string;
  calls: number;
  slow: number;
  failed: number;
  p95Ms: number | null;
  maxMs: number | null;
  lastAt: string | null;
}
export interface MicaScopeFreshness {
  id: string;
  scope: string;
  file: string | null;
  lastAt: string | null;
  bytes: number;
  samples: number;
  state: 'running' | 'stale' | 'unavailable';
  note: string;
}
export interface MicaSessionVolume {
  id: string;
  sizeMb: number;
  updatedAt: string;
}
export interface MicaOverview {
  generatedAt: string;
  day: string;
  range: Range;
  paths: { logs: string; sessions: string; desktopApp: string | null };
  hosts: MicaHostUsage[];
  hostSummary: {
    activeHosts: number;
    windowHosts: number;
    peakHostRssMb: number | null;
    peakHostLabel: string | null;
    shortLived: number;
  };
  memory: MicaMemoryPoint[];
  memoryNote: string;
  kinds: MicaProcessKind[];
  processAt: string | null;
  totals: { processes: number; footprintMb: number; rssMb: number; cpuPct: number | null; appServers: number };
  renderer: {
    samples: number;
    lagP50: number | null;
    lagP95: number | null;
    lagP99: number | null;
    over32: number;
    over100: number;
    over1000: number;
    worst: number | null;
    worstAt: string | null;
    dropped: number;
    pages: MicaPageStat[];
    heap: { ts: number; heapMb: number | null; heapMaxMb: number | null; dom: number | null }[];
  };
  channels: MicaChannelStat[];
  invoke: { calls: number; slow: number; failed: number };
  lifecycle: { boots: number; shutdowns: number; sessions: string[]; lastBootAt: string | null; openPids: number };
  chat: { reaped: number; maxIdleSeconds: number | null; lastAt: string | null };
  sessions: { count: number; totalMb: number; largest: MicaSessionVolume[]; error: string | null };
  scopes: MicaScopeFreshness[];
  findings: { level: Health; title: string; detail: string }[];
  warnings: string[];
}
