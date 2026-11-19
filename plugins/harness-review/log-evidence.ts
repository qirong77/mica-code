import { constants } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveLogDir } from '@packages/mica-config/brand.js';
import { fileSignature, ProjectionIndex } from './derived-index.js';

const MAX_FILES = 64;
const TAIL_BYTES = 128 * 1024;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 2048;
const MAX_GROUPS = 100;
const STAT_CONCURRENCY = 16;
function rethrowAbort(error: unknown, signal?: AbortSignal): void {
  if (error instanceof Error && error.name === 'AbortError') throw error;
  signal?.throwIfAborted();
}

async function checkpoint(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal.throwIfAborted();
}

const token = (value: unknown, max = 80): string | undefined =>
  typeof value === 'string' && value.length <= max && /^[a-zA-Z0-9][a-zA-Z0-9:._+-]*$/.test(value) ? value : undefined;
const scalar = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const oneOf = (value: unknown, values: string[]): string | undefined =>
  typeof value === 'string' && values.includes(value) ? value : undefined;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const time = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 8.64e15 ? n : undefined;
};

type Row = {
  at: number;
  kind: 'operation' | 'heartbeat' | 'experience' | 'system' | 'memory' | 'writer';
  plugin?: string;
  pluginVersion?: string;
  operation?: string;
  operationId?: string;
  eventId?: string;
  event?: string;
  surface?: string;
  action?: string;
  outcome?: string;
  code?: string;
  pid?: number;
  generation?: string;
  ms?: number;
  maxMs?: number;
  count?: number;
  scope?: string;
  level?: string;
  crash?: boolean;
  rssMB?: number;
  heapMB?: number;
  firstAt?: number;
  lastAt?: number;
  windowStart?: number;
  windowEnd?: number;
  taskId?: string;
  durationBuckets?: number[];
  writer?: WriterHealthEvidence;
};
type FileProjection = {
  rows: Row[];
  malformed: number;
  ignored: number;
  partialLines: number;
  rowLimitReached: boolean;
};
export type LogEvidence = {
  scope: 'machine';
  coverage: {
    candidateFiles: number;
    scannedFiles: number;
    omittedFiles: number;
    unreadableFiles: number;
    inspectedBytes: number;
    truncatedFiles: number;
    malformedLines: number;
    ignoredLines: number;
    partialLines: number;
    rowLimitReached: boolean;
    groupLimitReached: boolean;
    earliestAt?: string;
    latestAt?: string;
    /** Metadata for every candidate is inspected before selecting fresh tails. */
    metadataFiles?: number;
    selection?: 'mtime';
    groups?: Record<'operations' | 'experience' | 'system' | 'memory' | 'writerHealth', number>;
    domains?: { domain: Row['kind']; records: number; earliestAt: string; latestAt: string }[];
    heartbeatRecords?: number;
    heartbeatCount?: number;
    writerHealthObserved?: boolean;
  };
  operations: {
    plugin: string;
    pluginVersion?: string;
    operation: string;
    surface?: string;
    outcome: string;
    code?: string;
    starts: number;
    finishes: number;
    totalMs: number;
    maxMs: number;
    pid?: number;
    generation?: string;
    heartbeatCount?: number;
    durationBuckets?: number[];
  }[];
  experience: {
    plugin: string;
    pluginVersion: string;
    event: string;
    surface?: string;
    action?: string;
    outcome?: string;
    records: number;
    count: number;
  }[];
  system: {
    scope: string;
    event: string;
    level: string;
    count: number;
    crashes: number;
    pluginId?: string;
    pluginVersion?: string;
    pid?: number;
    generation?: string;
  }[];
  memory: { pid?: number; samples: number; peakRssMB: number; peakHeapMB?: number }[];
  /** All inspected records, independent of the 100-row display-group limit. */
  totals?: LogTotals;
  pluginTotals?: PluginLogTotals[];
  writerHealth?: WriterHealthEvidence[];
  interpretation: string;
};

export type LogTotals = {
  operationStarts: number;
  operationFinishes: number;
  operationErrors: number;
  operationUnknown: number;
  experienceRecords: number;
  experienceCount: number;
  systemWarnings: number;
  systemErrors: number;
  crashes: number;
  memorySamples: number;
};
export type PluginLogTotals = {
  plugin: string;
  operationStarts: number;
  operationFinishes: number;
  operationErrors: number;
  operationUnknown: number;
  impressions: number;
  clicks: number;
  warnings: number;
  errors: number;
};
export type WriterHealthEvidence = {
  pid: number;
  generation: string;
  at: string;
  dropped: number;
  overflowDrops: number;
  serializationFailures: number;
  writeFailures: number;
  lostLowerBound: number;
  checkpointFailures: number;
  logLevel: string;
  pluginLogEnabled: boolean;
  closePolicy: 'best_effort_sync_exit';
};

/** One-way whitelist projection. No spread of a log envelope/data/error is allowed here. */
function project(raw: unknown): Row | undefined {
  const row = object(raw);
  const at = time(row.at ?? row.time);
  if (at === undefined) return;
  const pid = Number.isSafeInteger(row.pid) && Number(row.pid) > 0 ? Number(row.pid) : undefined;
  const generation = token(row.generation, 80) ?? 'unknown';
  if (row.scope === 'writer-health' && row.event === 'writer.checkpoint' && row.schemaVersion === 1) {
    const fields = [
      'dropped',
      'overflowDrops',
      'serializationFailures',
      'writeFailures',
      'lostLowerBound',
      'checkpointFailures',
    ] as const;
    if (
      !pid ||
      fields.some((key) => !Number.isSafeInteger(row[key]) || Number(row[key]) < 0) ||
      !['debug', 'info', 'warn', 'error', 'off', 'silent'].includes(String(row.logLevel)) ||
      typeof row.pluginLogEnabled !== 'boolean' ||
      row.closePolicy !== 'best_effort_sync_exit'
    )
      return;
    return {
      at,
      kind: 'writer',
      pid,
      generation,
      writer: {
        pid,
        generation,
        at: new Date(at).toISOString(),
        dropped: Number(row.dropped),
        overflowDrops: Number(row.overflowDrops),
        serializationFailures: Number(row.serializationFailures),
        writeFailures: Number(row.writeFailures),
        lostLowerBound: Number(row.lostLowerBound),
        checkpointFailures: Number(row.checkpointFailures),
        logLevel: String(row.logLevel),
        pluginLogEnabled: row.pluginLogEnabled,
        closePolicy: 'best_effort_sync_exit',
      },
    };
  }
  if (row.scope === 'plugin-heartbeat' && row.event === 'background.heartbeat' && row.schemaVersion === 1) {
    const heartbeatId = token(row.heartbeatId);
    const plugin = token(row.plugin, 160),
      operation = token(row.operation);
    const firstAt = time(row.firstAt),
      lastAt = time(row.lastAt),
      windowStart = time(row.windowStart),
      windowEnd = time(row.windowEnd);
    const buckets = row.durationBuckets;
    if (
      !heartbeatId ||
      !plugin ||
      !operation ||
      !Number.isSafeInteger(row.count) ||
      Number(row.count) < 1 ||
      !['success', 'waiting', 'skipped'].includes(String(row.outcome)) ||
      scalar(row.totalMs) === undefined ||
      scalar(row.maxMs) === undefined ||
      firstAt === undefined ||
      lastAt === undefined ||
      firstAt > lastAt ||
      windowStart === undefined ||
      windowEnd === undefined ||
      windowStart >= windowEnd ||
      !Array.isArray(buckets) ||
      buckets.length !== 5 ||
      buckets.some((n) => !Number.isSafeInteger(n) || n < 0) ||
      buckets.reduce((a, b) => a + b, 0) !== row.count ||
      JSON.stringify(row.durationBoundsMs) !== '[10,100,1000,10000]'
    )
      return;
    return {
      at,
      kind: 'heartbeat',
      eventId: heartbeatId,
      plugin,
      operation,
      pid,
      generation,
      pluginVersion: token(row.pluginVersion, 60) ?? 'unknown',
      surface: 'background',
      outcome: String(row.outcome),
      code: token(row.code, 60),
      taskId: token(row.taskId),
      count: Number(row.count),
      ms: Number(row.totalMs),
      // maxMs is carried separately because ms represents the whole combined window.
      firstAt,
      lastAt,
      windowStart,
      windowEnd,
      durationBuckets: buckets as number[],
      maxMs: Number(row.maxMs),
    };
  }
  if (row.scope === 'plugin-operation' && ['operation.start', 'operation.finish'].includes(String(row.event))) {
    const plugin = token(row.plugin, 160);
    const operation = token(row.operation);
    const operationId =
      typeof row.operationId === 'string' && /^[a-f0-9-]{36}$/i.test(row.operationId) ? row.operationId : undefined;
    if (!plugin || !operation || !operationId) return;
    return {
      at,
      kind: 'operation',
      plugin,
      operation,
      operationId,
      pid,
      generation,
      pluginVersion: token(row.pluginVersion, 60) ?? 'unknown',
      event: String(row.event),
      surface: oneOf(row.surface, [
        'tool',
        'command',
        'panel',
        'action',
        'menu',
        'background',
        'hook',
        'lifecycle',
        'page',
        'mcp',
        'launcher',
      ]),
      outcome: oneOf(row.outcome, [
        'success',
        'error',
        'cancelled',
        'timeout',
        'declined',
        'waiting',
        'conflict',
        'busy',
        'partial',
        'unknown',
        'skipped',
      ]),
      code: token(row.code, 60),
      ms: scalar(row.ms),
    };
  }
  if (row.event === 'plugin:experience') {
    const data = object(row.data);
    const plugin = token(row.pluginId ?? row.plugin, 160);
    const event = oneOf(data.event, ['impression', 'click', 'dismiss', 'update', 'failure', 'check', 'clear']);
    const pluginVersion = token(data.pluginVersion, 60);
    const eventId =
      typeof data.eventId === 'string' && /^[a-f0-9-]{36}$/i.test(data.eventId) ? data.eventId : undefined;
    if (data.schemaVersion !== 1 || !plugin || !event || !pluginVersion || !eventId) return;
    return {
      at,
      kind: 'experience',
      plugin,
      pluginVersion,
      eventId,
      event,
      surface: oneOf(data.surface, ['card', 'panel', 'tool', 'background', 'page', 'launcher']),
      action: typeof data.action === 'string' && /^[a-z][a-z0-9:_-]{0,47}$/.test(data.action) ? data.action : undefined,
      outcome: oneOf(data.outcome, ['success', 'error', 'stale', 'dismissed']),
      count:
        Number.isSafeInteger(data.count) && Number(data.count) >= 0 ? Math.min(Number(data.count), 10000) : undefined,
    };
  }
  if (row.scope === 'mem' && scalar(row.rss) !== undefined)
    return {
      at,
      kind: 'memory',
      pid,
      rssMB: scalar(row.rss),
      heapMB: scalar(row.heap),
      scope: 'mem',
      event: token(row.event),
      level: oneOf(row.level, ['warn', 'error']),
    };
  if (row.level !== 'warn' && row.level !== 'error') return;
  const scope = token(row.scope);
  const event = token(row.event);
  if (!scope || !event) return;
  // A supervisor's intentional stop is not a crash. Do not inspect stderr/error text.
  const killed =
    row.killed === true ||
    row.aborted === true ||
    row.status === 'killed' ||
    row.outcome === 'killed' ||
    row.signal === 'SIGTERM' ||
    row.reason === 'killed' ||
    row.exitCode === 15 ||
    row.exit_code === 15;
  const crash =
    !killed &&
    ((['render-process-gone', 'child-process-gone'].includes(event) &&
      ['crashed', 'oom'].includes(String(row.reason))) ||
      (/(?:^|[.:_-])(?:crash|crashed|exit)$/.test(event) &&
        (row.level === 'error' ||
          (typeof row.exitCode === 'number' && row.exitCode !== 0) ||
          row.signal === 'SIGKILL')));
  const plugin = token(row.pluginId ?? row.plugin, 160);
  return {
    at,
    kind: 'system',
    scope,
    event,
    level: String(row.level),
    crash,
    ...(plugin ? { plugin, pluginVersion: token(row.pluginVersion, 60) ?? 'unknown', pid, generation } : {}),
  };
}

/** Read-only tail reader. The cache holds bounded whitelist scalars, never log bodies. */
export class LogEvidenceReader {
  private readonly cache = new ProjectionIndex<FileProjection>(64, 4 * 1024 * 1024);

  async read(directory = resolveLogDir(), signal?: AbortSignal): Promise<LogEvidence> {
    signal?.throwIfAborted();
    const coverage: LogEvidence['coverage'] = {
      candidateFiles: 0,
      scannedFiles: 0,
      omittedFiles: 0,
      unreadableFiles: 0,
      inspectedBytes: 0,
      truncatedFiles: 0,
      malformedLines: 0,
      ignoredLines: 0,
      partialLines: 0,
      rowLimitReached: false,
      groupLimitReached: false,
      metadataFiles: 0,
      selection: 'mtime',
      heartbeatRecords: 0,
      heartbeatCount: 0,
      writerHealthObserved: false,
    };
    const result: LogEvidence = {
      scope: 'machine',
      coverage,
      operations: [],
      experience: [],
      system: [],
      memory: [],
      totals: {
        operationStarts: 0,
        operationFinishes: 0,
        operationErrors: 0,
        operationUnknown: 0,
        experienceRecords: 0,
        experienceCount: 0,
        systemWarnings: 0,
        systemErrors: 0,
        crashes: 0,
        memorySamples: 0,
      },
      pluginTotals: [],
      writerHealth: [],
      interpretation:
        'Machine-wide bounded log tails, not workspace/run attribution or complete history. Totals cover all inspected/deduplicated records before display-group limits; counts and peaks are lower bounds, not complete history. Routine background heartbeat counts exclude immediate transition records; their duration buckets use [10,100,1000,10000] ms. Domain time bounds describe inspected records only; omitted files/bytes/rows, retention and missing writer checkpoints remain unknown. Operation success is handler completion, not user validation; starts without a finish are unknown. Normal killed/exit 15 are not crashes. No bodies, paths, URLs, commands or error text are copied.',
    };
    let names: string[];
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      signal?.throwIfAborted();
      names = entries.filter((e) => e.isFile() && /^[A-Za-z0-9._-]+\.jsonl$/.test(e.name)).map((e) => e.name);
    } catch (error) {
      rethrowAbort(error, signal);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') coverage.unreadableFiles++;
      return result;
    }
    coverage.candidateFiles = names.length;
    // File mtime only selects log tails, never Agent runs.
    const candidates: { name: string; modified: number }[] = [];
    // A fixed worker pool inspects all metadata before fresh-tail selection.
    // Name ordering can no longer exclude a fresh log domain at file 513.
    let next = 0;
    const unavailable = new Set<string>();
    await Promise.all(
      Array.from({ length: Math.min(STAT_CONCURRENCY, names.length) }, async () => {
        while (next < names.length) {
          const name = names[next++];
          signal?.throwIfAborted();
          try {
            const info = await stat(join(directory, name));
            signal?.throwIfAborted();
            coverage.metadataFiles!++;
            if (!info.isFile()) {
              unavailable.add(name);
              continue;
            }
            candidates.push({ name, modified: info.mtimeMs });
            candidates.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
            if (candidates.length > MAX_FILES) candidates.pop();
          } catch (error) {
            rethrowAbort(error, signal);
            unavailable.add(name);
          }
        }
      }),
    );
    coverage.unreadableFiles = unavailable.size;
    signal?.throwIfAborted();
    candidates.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
    const keys = new Set<string>();
    const rows: Row[] = [];
    for (const { name } of candidates.slice(0, MAX_FILES)) {
      if (signal) await checkpoint(signal);
      if (coverage.inspectedBytes >= MAX_BYTES) break;
      const path = join(directory, name);
      keys.add(path);
      try {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          signal?.throwIfAborted();
          const info = await handle.stat();
          signal?.throwIfAborted();
          if (!info.isFile()) {
            unavailable.add(name);
            continue;
          }
          const length = Math.min(info.size, TAIL_BYTES, MAX_BYTES - coverage.inspectedBytes);
          const start = info.size - length;
          const signature = `${fileSignature(info)}:${start}:${length}`;
          let projection = this.cache.get(path, signature);
          if (!projection) {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, start);
            signal?.throwIfAborted();
            let text = buffer.subarray(0, bytesRead).toString('utf8');
            projection = { rows: [], malformed: 0, ignored: 0, partialLines: 0, rowLimitReached: false };
            // Starting mid-line always discards the first fragment (even if it looks valid).
            if (start > 0) {
              const end = text.indexOf('\n');
              text = end < 0 ? '' : text.slice(end + 1);
              projection.partialLines++;
            }
            if (text && !text.endsWith('\n')) {
              text = text.slice(0, text.lastIndexOf('\n') + 1);
              projection.partialLines++;
            }
            let lineIndex = 0;
            for (const line of text.split('\n')) {
              if (signal && lineIndex++ % 128 === 0) await checkpoint(signal);
              if (!line.trim()) continue;
              if (projection.rows.length >= MAX_ROWS) {
                projection.rowLimitReached = true;
                break;
              }
              try {
                const row = project(JSON.parse(line));
                if (row) projection.rows.push(row);
                else projection.ignored++;
              } catch (error) {
                rethrowAbort(error, signal);
                projection.malformed++;
              }
            }
            const after = await handle.stat();
            signal?.throwIfAborted();
            if (signature === `${fileSignature(after)}:${start}:${length}`) this.cache.set(path, signature, projection);
          }
          signal?.throwIfAborted();
          coverage.scannedFiles++;
          coverage.inspectedBytes += length;
          if (start > 0) coverage.truncatedFiles++;
          coverage.malformedLines += projection.malformed;
          coverage.ignoredLines += projection.ignored;
          coverage.partialLines += projection.partialLines;
          coverage.rowLimitReached ||= projection.rowLimitReached;
          rows.push(...projection.rows);
        } finally {
          await handle.close();
        }
      } catch (error) {
        rethrowAbort(error, signal);
        unavailable.add(name);
      }
      signal?.throwIfAborted();
    }
    coverage.unreadableFiles = unavailable.size;
    coverage.omittedFiles = Math.max(0, names.length - coverage.scannedFiles - coverage.unreadableFiles);
    const groups = new Map<string, number>();
    const seen = new Set<string>();
    const group = <T>(kind: string, key: string, list: T[], create: () => T): T => {
      const id = `${kind}:${key}`;
      const index = groups.get(id);
      if (index !== undefined) return list[index];
      groups.set(id, list.length);
      const value = create();
      list.push(value);
      return value;
    };
    let earliest = Infinity,
      latest = -Infinity;
    const operationKey = (row: Row) =>
      `${row.pid}:${row.generation}:${row.plugin}:${row.pluginVersion}:${row.operationId}`;
    const terminals = new Map<string, Row>();
    const pluginTotals = new Map<string, PluginLogTotals>();
    const domainTotals = new Map<Row['kind'], { records: number; first: number; last: number }>();
    const pluginTotal = (plugin: string) => {
      let value = pluginTotals.get(plugin);
      if (!value) {
        value = {
          plugin,
          operationStarts: 0,
          operationFinishes: 0,
          operationErrors: 0,
          operationUnknown: 0,
          impressions: 0,
          clicks: 0,
          warnings: 0,
          errors: 0,
        };
        pluginTotals.set(plugin, value);
      }
      return value;
    };
    let rowIndex = 0;
    for (const row of rows) {
      if (signal && rowIndex++ % 128 === 0) await checkpoint(signal);
      if (row.kind === 'operation' && row.event === 'operation.finish') {
        const key = operationKey(row);
        if (!terminals.has(key) || terminals.get(key)!.at <= row.at) terminals.set(key, row);
      }
    }
    rowIndex = 0;
    for (const row of rows) {
      if (signal && rowIndex++ % 128 === 0) await checkpoint(signal);
      earliest = Math.min(earliest, row.firstAt ?? row.at);
      latest = Math.max(latest, row.lastAt ?? row.at);
      const domain = domainTotals.get(row.kind) ?? { records: 0, first: Infinity, last: -Infinity };
      domain.records++;
      domain.first = Math.min(domain.first, row.firstAt ?? row.at);
      domain.last = Math.max(domain.last, row.lastAt ?? row.at);
      domainTotals.set(row.kind, domain);
      if (row.kind === 'memory' && row.level && row.event) {
        const warning = group('sys', ['mem', row.event, row.level].join('|'), result.system, () => ({
          scope: 'mem',
          event: row.event!,
          level: row.level!,
          count: 0,
          crashes: 0,
        }));
        warning.count++;
        result.totals![row.level === 'error' ? 'systemErrors' : 'systemWarnings']++;
      }
      if (row.kind === 'operation' || row.kind === 'heartbeat') {
        const heartbeat = row.kind === 'heartbeat';
        const id = heartbeat
          ? [
              'heartbeat',
              row.pid,
              row.generation,
              row.plugin,
              row.pluginVersion,
              row.eventId,
            ].join(':')
          : `${operationKey(row)}:${row.event}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const terminal = heartbeat ? row : terminals.get(operationKey(row));
        const outcome = terminal?.outcome ?? row.outcome ?? 'unknown';
        const code = terminal?.code ?? row.code;
        const key = [
          row.plugin,
          row.pluginVersion,
          row.pid,
          row.generation,
          row.operation,
          row.surface,
          outcome,
          code,
        ].join('|');
        const item = group('op', key, result.operations, () => ({
          plugin: row.plugin!,
          pluginVersion: row.pluginVersion,
          pid: row.pid,
          generation: row.generation,
          operation: row.operation!,
          surface: row.surface,
          outcome,
          code,
          starts: 0,
          finishes: 0,
          totalMs: 0,
          maxMs: 0,
        }));
        const totals = pluginTotal(row.plugin!);
        const weight = heartbeat ? row.count! : 1;
        if (row.event === 'operation.start' || heartbeat) {
          item.starts += weight;
          totals.operationStarts += weight;
          result.totals!.operationStarts += weight;
          if (!terminal && !heartbeat) {
            totals.operationUnknown++;
            result.totals!.operationUnknown++;
          }
        }
        if (row.event !== 'operation.start') {
          item.finishes += weight;
          item.totalMs += row.ms ?? 0;
          item.maxMs = Math.max(item.maxMs, heartbeat ? row.maxMs! : (row.ms ?? 0));
          totals.operationFinishes += weight;
          result.totals!.operationFinishes += weight;
          if (outcome === 'error' || outcome === 'timeout') {
            totals.operationErrors += weight;
            result.totals!.operationErrors += weight;
          } else if (outcome === 'unknown') {
            totals.operationUnknown += weight;
            result.totals!.operationUnknown += weight;
          }
        }
        if (heartbeat) {
          coverage.heartbeatRecords!++;
          coverage.heartbeatCount! += weight;
          item.heartbeatCount = (item.heartbeatCount ?? 0) + weight;
          item.durationBuckets = (item.durationBuckets ?? [0, 0, 0, 0, 0]).map((n, i) => n + row.durationBuckets![i]);
        }
      } else if (row.kind === 'experience') {
        const id = `experience:${row.plugin}:${row.eventId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const key = [row.plugin, row.pluginVersion, row.event, row.surface, row.action, row.outcome].join('|');
        const item = group('ex', key, result.experience, () => ({
          plugin: row.plugin!,
          pluginVersion: row.pluginVersion!,
          event: row.event!,
          surface: row.surface,
          action: row.action,
          outcome: row.outcome,
          records: 0,
          count: 0,
        }));
        item.records++;
        item.count += row.count ?? 1;
        result.totals!.experienceRecords++;
        result.totals!.experienceCount += row.count ?? 1;
        if (row.event === 'click') pluginTotal(row.plugin!).clicks += row.count ?? 1;
        if (row.event === 'impression') pluginTotal(row.plugin!).impressions += row.count ?? 1;
      } else if (row.kind === 'system') {
        const item = group(
          'sys',
          [row.scope, row.event, row.level, row.plugin, row.pluginVersion, row.pid, row.generation].join('|'),
          result.system,
          () => ({
            scope: row.scope!,
            event: row.event!,
            level: row.level!,
            count: 0,
            crashes: 0,
            ...(row.plugin
              ? { pluginId: row.plugin, pluginVersion: row.pluginVersion, pid: row.pid, generation: row.generation }
              : {}),
          }),
        );
        item.count++;
        if (row.crash) item.crashes++;
        result.totals![row.level === 'error' ? 'systemErrors' : 'systemWarnings']++;
        if (row.crash) result.totals!.crashes++;
        if (row.plugin) pluginTotal(row.plugin)[row.level === 'error' ? 'errors' : 'warnings']++;
      } else if (row.kind === 'writer') {
        coverage.writerHealthObserved = true;
        const item = group('writer', `${row.pid}:${row.generation}`, result.writerHealth!, () => ({ ...row.writer! }));
        const newest = row.writer!;
        for (const key of [
          'dropped',
          'overflowDrops',
          'serializationFailures',
          'writeFailures',
          'lostLowerBound',
          'checkpointFailures',
        ] as const)
          item[key] = Math.max(item[key], newest[key]);
        if (newest.at >= item.at) {
          item.at = newest.at;
          item.logLevel = newest.logLevel;
          item.pluginLogEnabled = newest.pluginLogEnabled;
        }
      } else {
        const item = group('mem', String(row.pid), result.memory, () => ({ pid: row.pid, samples: 0, peakRssMB: 0 }));
        item.samples++;
        item.peakRssMB = Math.max(item.peakRssMB, row.rssMB ?? 0);
        if (row.heapMB !== undefined) item.peakHeapMB = Math.max(item.peakHeapMB ?? 0, row.heapMB);
        result.totals!.memorySamples++;
      }
    }
    if (earliest !== Infinity) {
      coverage.earliestAt = new Date(earliest).toISOString();
      coverage.latestAt = new Date(latest).toISOString();
    }
    const priority = (outcome: string) =>
      outcome === 'error' || outcome === 'timeout' ? 0 : outcome === 'unknown' ? 1 : outcome === 'success' ? 3 : 2;
    result.operations.sort(
      (a, b) =>
        priority(a.outcome) - priority(b.outcome) || b.finishes - a.finishes || a.plugin.localeCompare(b.plugin),
    );
    result.experience.sort(
      (a, b) =>
        Number(b.outcome === 'error' || b.event === 'failure') -
          Number(a.outcome === 'error' || a.event === 'failure') || b.count - a.count,
    );
    result.system.sort(
      (a, b) => b.crashes - a.crashes || Number(b.level === 'error') - Number(a.level === 'error') || b.count - a.count,
    );
    result.memory.sort((a, b) => b.peakRssMB - a.peakRssMB);
    result.writerHealth!.sort(
      (a, b) => b.lostLowerBound - a.lostLowerBound || b.writeFailures - a.writeFailures || b.at.localeCompare(a.at),
    );
    coverage.groups = {
      operations: result.operations.length,
      experience: result.experience.length,
      system: result.system.length,
      memory: result.memory.length,
      writerHealth: result.writerHealth!.length,
    };
    for (const list of [result.operations, result.experience, result.system, result.memory, result.writerHealth!]) {
      if (list.length > MAX_GROUPS) coverage.groupLimitReached = true;
      list.splice(MAX_GROUPS);
    }
    result.pluginTotals = [...pluginTotals.values()].sort(
      (a, b) =>
        b.operationErrors + b.errors - a.operationErrors - a.errors ||
        b.operationUnknown - a.operationUnknown ||
        a.plugin.localeCompare(b.plugin),
    );
    if (result.pluginTotals.length > MAX_GROUPS) coverage.groupLimitReached = true;
    result.pluginTotals.splice(MAX_GROUPS);
    coverage.domains = [...domainTotals].map(([domain, value]) => ({
      domain,
      records: value.records,
      earliestAt: new Date(value.first).toISOString(),
      latestAt: new Date(value.last).toISOString(),
    }));
    signal?.throwIfAborted();
    this.cache.retain(keys);
    return result;
  }
}
