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
  kind: 'operation' | 'experience' | 'system' | 'memory';
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
  ms?: number;
  count?: number;
  scope?: string;
  level?: string;
  crash?: boolean;
  rssMB?: number;
  heapMB?: number;
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
  system: { scope: string; event: string; level: string; count: number; crashes: number }[];
  memory: { pid?: number; samples: number; peakRssMB: number; peakHeapMB?: number }[];
  interpretation: string;
};

/** One-way whitelist projection. No spread of a log envelope/data/error is allowed here. */
function project(raw: unknown): Row | undefined {
  const row = object(raw);
  const at = time(row.at ?? row.time);
  if (at === undefined) return;
  const pid = Number.isSafeInteger(row.pid) && Number(row.pid) > 0 ? Number(row.pid) : undefined;
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
      pluginVersion: token(row.pluginVersion, 60),
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
    const eventId = typeof data.eventId === 'string' && /^[a-f0-9-]{36}$/i.test(data.eventId) ? data.eventId : undefined;
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
    row.exitCode === 15 ||
    row.exit_code === 15;
  const crash =
    !killed &&
    /(?:^|[.:_-])(?:crash|crashed|exit)$/.test(event) &&
    (row.level === 'error' || (typeof row.exitCode === 'number' && row.exitCode !== 0) || row.signal === 'SIGKILL');
  return { at, kind: 'system', scope, event, level: String(row.level), crash };
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
    };
    const result: LogEvidence = {
      scope: 'machine',
      coverage,
      operations: [],
      experience: [],
      system: [],
      memory: [],
      interpretation:
        'Machine-wide bounded log tails, not workspace/run attribution or complete history. Counts and memory peaks cover only inspected records; file/byte/row/group limits, partial lines, unreadable files and retention can omit evidence. Operation success is handler completion, not user validation; starts without a finish are unknown, not failures. Neutral outcomes and normal killed/exit 15 are not crashes. No bodies, paths, URLs, commands or error text are copied.',
    };
    let names: string[];
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      signal?.throwIfAborted();
      names = entries
        .filter((e) => e.isFile() && /^[A-Za-z0-9._-]+\.jsonl$/.test(e.name))
        .map((e) => e.name)
        .sort()
        .reverse();
    } catch (error) {
      rethrowAbort(error, signal);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') coverage.unreadableFiles++;
      return result;
    }
    coverage.candidateFiles = names.length;
    // File mtime only selects log tails, never Agent runs.
    const candidates = await Promise.all(
      names.slice(0, 512).map(async (name) => {
        signal?.throwIfAborted();
        try {
          const info = await stat(join(directory, name));
          signal?.throwIfAborted();
          return { name, modified: info.mtimeMs };
        } catch (error) {
          rethrowAbort(error, signal);
          return { name, modified: 0 };
        }
      }),
    );
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
          if (!info.isFile()) continue;
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
            if (signature === `${fileSignature(after)}:${start}:${length}`)
              this.cache.set(path, signature, projection);
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
        coverage.unreadableFiles++;
      }
      signal?.throwIfAborted();
    }
    coverage.omittedFiles = Math.max(0, names.length - coverage.scannedFiles - coverage.unreadableFiles);
    const groups = new Map<string, number>();
    const seen = new Set<string>();
    const group = <T>(kind: string, key: string, list: T[], create: () => T): T | undefined => {
      const id = `${kind}:${key}`;
      const index = groups.get(id);
      if (index !== undefined) return list[index];
      if (list.length >= MAX_GROUPS) {
        coverage.groupLimitReached = true;
        return;
      }
      groups.set(id, list.length);
      const value = create();
      list.push(value);
      return value;
    };
    let earliest = Infinity,
      latest = -Infinity;
    const operationKey = (row: Row) => `${row.pid}:${row.plugin}:${row.operationId}`;
    const terminals = new Map<string, Row>();
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
      earliest = Math.min(earliest, row.at);
      latest = Math.max(latest, row.at);
      if (row.kind === 'memory' && row.level && row.event) {
        const warning = group('sys', ['mem', row.event, row.level].join('|'), result.system, () => ({
          scope: 'mem',
          event: row.event!,
          level: row.level!,
          count: 0,
          crashes: 0,
        }));
        if (warning) warning.count++;
      }
      if (row.kind === 'operation') {
        const id = `${row.pid}:${row.plugin}:${row.operationId}:${row.event}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const terminal = terminals.get(operationKey(row));
        const outcome = terminal?.outcome ?? row.outcome ?? 'unknown';
        const code = terminal?.code ?? row.code;
        const key = [row.plugin, row.pluginVersion, row.operation, row.surface, outcome, code].join('|');
        const item = group('op', key, result.operations, () => ({
          plugin: row.plugin!,
          pluginVersion: row.pluginVersion,
          operation: row.operation!,
          surface: row.surface,
          outcome,
          code,
          starts: 0,
          finishes: 0,
          totalMs: 0,
          maxMs: 0,
        }));
        if (!item) continue;
        if (row.event === 'operation.start') item.starts++;
        else {
          item.finishes++;
          item.totalMs += row.ms ?? 0;
          item.maxMs = Math.max(item.maxMs, row.ms ?? 0);
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
        if (item) {
          item.records++;
          item.count += row.count ?? 1;
        }
      } else if (row.kind === 'system') {
        const item = group('sys', [row.scope, row.event, row.level].join('|'), result.system, () => ({
          scope: row.scope!,
          event: row.event!,
          level: row.level!,
          count: 0,
          crashes: 0,
        }));
        if (item) {
          item.count++;
          if (row.crash) item.crashes++;
        }
      } else {
        const item = group('mem', String(row.pid), result.memory, () => ({ pid: row.pid, samples: 0, peakRssMB: 0 }));
        if (item) {
          item.samples++;
          item.peakRssMB = Math.max(item.peakRssMB, row.rssMB ?? 0);
          if (row.heapMB !== undefined) item.peakHeapMB = Math.max(item.peakHeapMB ?? 0, row.heapMB);
        }
      }
    }
    if (earliest !== Infinity) {
      coverage.earliestAt = new Date(earliest).toISOString();
      coverage.latestAt = new Date(latest).toISOString();
    }
    signal?.throwIfAborted();
    this.cache.retain(keys);
    return result;
  }
}
