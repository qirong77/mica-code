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
