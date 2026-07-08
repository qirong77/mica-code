import { atom } from 'nanostores';

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_MAX_SNAPSHOTS = 1_440;

export type MemoryUsageValues = {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};

export type ResourceUsageValues = Partial<Record<keyof NodeJS.ResourceUsage, number>>;

export type MemoryUsageSnapshot = {
  id: number;
  at: number;
  atIso: string;
  label: string;
  elapsedMs: number;
  pid: number;
  uptimeSec: number;
  memory: MemoryUsageValues;
  resourceUsage?: ResourceUsageValues;
};

export type MemoryUsageMonitorOptions = {
  intervalMs?: number;
  maxSnapshots?: number;
};

export class MemoryUsageMonitor {
  readonly snapshots = atom<MemoryUsageSnapshot[]>([]);

  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private nextId = 0;
  private intervalMs = readPositiveInt(process.env.MICA_MEMORY_USAGE_INTERVAL_MS, DEFAULT_INTERVAL_MS);
  private maxSnapshots = readPositiveInt(process.env.MICA_MEMORY_USAGE_MAX_SNAPSHOTS, DEFAULT_MAX_SNAPSHOTS);

  start(options: MemoryUsageMonitorOptions = {}): void {
    if (process.env.MICA_MEMORY_USAGE === '0') return;
    if (options.intervalMs !== undefined) this.intervalMs = clampPositiveInt(options.intervalMs, DEFAULT_INTERVAL_MS);
    if (options.maxSnapshots !== undefined)
      this.maxSnapshots = clampPositiveInt(options.maxSnapshots, DEFAULT_MAX_SNAPSHOTS);
    if (this.timer) return;

    this.startedAt ||= Date.now();
    this.capture('startup');
    this.timer = setInterval(() => {
      this.capture('interval');
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  getIntervalMs(): number {
    return this.intervalMs;
  }

  getMaxSnapshots(): number {
    return this.maxSnapshots;
  }

  getStartedAt(): number | null {
    return this.startedAt || null;
  }

  capture(label = 'manual'): MemoryUsageSnapshot {
    const now = Date.now();
    this.startedAt ||= now;
    const snapshot: MemoryUsageSnapshot = {
      id: ++this.nextId,
      at: now,
      atIso: new Date(now).toISOString(),
      label,
      elapsedMs: now - this.startedAt,
      pid: process.pid,
      uptimeSec: process.uptime(),
      memory: normalizeMemoryUsage(process.memoryUsage()),
      resourceUsage: captureResourceUsage(),
    };

    const current = this.snapshots.get();
    const next = [...current, snapshot];
    this.snapshots.set(next.length > this.maxSnapshots ? next.slice(next.length - this.maxSnapshots) : next);
    return snapshot;
  }

  getSnapshots(): MemoryUsageSnapshot[] {
    return this.snapshots.get();
  }

  getLatest(): MemoryUsageSnapshot | undefined {
    const snapshots = this.snapshots.get();
    return snapshots[snapshots.length - 1];
  }

  clear(): void {
    this.snapshots.set([]);
  }
}

export const memoryUsageMonitor = new MemoryUsageMonitor();

function normalizeMemoryUsage(memory: NodeJS.MemoryUsage): MemoryUsageValues {
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers ?? 0,
  };
}

function captureResourceUsage(): ResourceUsageValues | undefined {
  if (typeof process.resourceUsage !== 'function') return undefined;
  const usage = process.resourceUsage();
  const result: ResourceUsageValues = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === 'number') result[key as keyof NodeJS.ResourceUsage] = value;
  }
  return result;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  return clampPositiveInt(Number(value), fallback);
}

function clampPositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.floor(value));
}
