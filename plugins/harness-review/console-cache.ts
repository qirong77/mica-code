import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConsolePlugin, ConsoleSnapshot } from './console-types.js';
import { fileSignature } from './derived-index.js';

/** Disposable projection, not a capture/assessment format. Old revisions are ignored. */
export const CONSOLE_CACHE_VERSION = 3;
export const CONSOLE_CACHE_FILE = 'console-snapshot-v3.json';
export function safeTaskId(value: string): string {
  return /^[a-z][a-z0-9:._-]{0,79}$/i.test(value) && !value.includes('://')
    ? value : `task-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}
const MAX_BYTES = 940 * 1024;
type Projector = (value: unknown) => unknown;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cache object');
  return value as Record<string, unknown>;
};
const number: Projector = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid cache count');
  return Math.min(value, Number.MAX_SAFE_INTEGER);
};
const bool: Projector = (value) => {
  if (typeof value !== 'boolean') throw new Error('Invalid cache flag');
  return value;
};
const string: Projector = (value) => {
  if (typeof value !== 'string' || value.length > 1000) throw new Error('Invalid cache text');
  return value;
};
const date: Projector = (value) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error('Invalid cache date');
  return new Date(value).toISOString();
};
const enumOf =
  (...values: unknown[]): Projector =>
  (value) => {
    if (!values.includes(value)) throw new Error('Invalid cache category');
    return value;
  };
const optional =
  (project: Projector): Projector =>
  (value) =>
    value === undefined ? undefined : project(value);
const nullable =
  (project: Projector): Projector =>
  (value) =>
    value === null ? null : project(value);
const array =
  (project: Projector, limit = 200): Projector =>
  (value) => {
    if (!Array.isArray(value) || value.length > limit) throw new Error('Invalid cache list');
    return value.map(project);
  };
const shape =
  (fields: Record<string, Projector>): Projector =>
  (value) => {
    const input = object(value),
      result: Record<string, unknown> = {};
    for (const [key, project] of Object.entries(fields)) {
      const item = project(input[key]);
      if (item !== undefined) result[key] = item;
    }
    return result;
  };
const counters = (keys: string): Projector => shape(Object.fromEntries(keys.split(' ').map((key) => [key, number])));
const healthCategories = [
  'runtime',
  'background',
  'hook',
  'dependency',
  'model',
  'storage',
  'configuration',
  'skill',
  'curator',
  'unknown',
] as const;
export function healthCategory(issueKey: string): NonNullable<ConsolePlugin['health']>['category'] {
  if (issueKey === 'runtime') return 'runtime';
  if (issueKey.startsWith('background:')) return 'background';
  if (issueKey.startsWith('hook:')) return 'hook';
  if (issueKey.startsWith('dependency:')) return 'dependency';
  if (issueKey.startsWith('llm:')) return 'model';
  if (issueKey.startsWith('skill:') || issueKey === 'skill' || issueKey === 'skills') return 'skill';
  if (issueKey.startsWith('storage:') || issueKey.startsWith('checkpoint:') || issueKey.startsWith('migration:')) return 'storage';
  if (['storage', 'configuration', 'curator'].includes(issueKey))
    return issueKey as 'storage' | 'configuration' | 'curator';
  return 'unknown';
}

/** Free-text health/message/hint and raw issue keys never cross this boundary. */
export function safeHealth(value: ConsolePlugin['health']): ConsolePlugin['health'] {
  if (!value) return null;
  const labels = {
    runtime: '运行',
    background: '后台任务',
    hook: '钩子',
    dependency: '外部依赖',
    model: '模型依赖',
    storage: '数据存储',
    configuration: '配置',
    skill: '技能',
    curator: '整理任务',
    unknown: '插件状态',
  };
  const category = healthCategories.includes(value.category ?? 'unknown') ? (value.category ?? 'unknown') : 'unknown';
  const level = value.level === 'error' ? 'error' : value.level === 'ok' ? 'ok' : 'warn';
  return {
    category,
    level,
    at: String(date(value.at)),
    versionKnown: value.versionKnown === true,
    message: `${value.versionKnown === true ? '' : '上次上报（当前版本未知）：'}${labels[category]}${level === 'ok' ? '正常上报（非验收）' : level === 'error' ? '故障上报' : '需关注'}；诊断原文不返回。`,
  };
}

const identity = { pluginVersion: optional(string), pid: optional(number), generation: optional(string) };
const logCoverage = shape({
  ...Object.fromEntries(
    'candidateFiles scannedFiles omittedFiles unreadableFiles inspectedBytes truncatedFiles malformedLines ignoredLines partialLines'
      .split(' ')
      .map((key) => [key, number]),
  ),
  rowLimitReached: bool,
  groupLimitReached: bool,
  earliestAt: optional(date),
  latestAt: optional(date),
  metadataFiles: optional(number),
  selection: optional(enumOf('mtime')),
  heartbeatRecords: optional(number),
  heartbeatCount: optional(number),
  writerHealthObserved: optional(bool),
  groups: optional(counters('operations experience system memory writerHealth')),
  domains: optional(
    array(
      shape({
        domain: enumOf('operation', 'heartbeat', 'experience', 'system', 'memory', 'writer'),
        records: number,
        earliestAt: date,
        latestAt: date,
      }),
      6,
    ),
  ),
});
const logTotals = counters(
  'operationStarts operationFinishes operationErrors operationUnknown experienceRecords experienceCount systemWarnings systemErrors crashes memorySamples',
);
const pluginTotals = shape({
  plugin: string,
  ...Object.fromEntries(
    'operationStarts operationFinishes operationErrors operationUnknown impressions clicks warnings errors'
      .split(' ')
      .map((key) => [key, number]),
  ),
});
const logs = shape({
  scope: enumOf('machine'),
  coverage: logCoverage,
  totals: optional(logTotals),
  pluginTotals: optional(array(pluginTotals, 100)),
  operations: array(
    shape({
      plugin: string,
      ...identity,
      operation: string,
      surface: optional(string),
      outcome: string,
      code: optional(string),
      starts: number,
      finishes: number,
      totalMs: number,
      maxMs: number,
      heartbeatCount: optional(number),
      durationBuckets: optional(array(number, 5)),
    }),
    100,
  ),
  experience: array(
    shape({
      plugin: string,
      pluginVersion: string,
      event: string,
      surface: optional(string),
      action: optional(string),
      outcome: optional(string),
      records: number,
      count: number,
    }),
    100,
  ),
  system: array(
    shape({
      scope: string,
      event: string,
      level: string,
      count: number,
      crashes: number,
      pluginId: optional(string),
      ...identity,
    }),
    100,
  ),
  memory: array(
    shape({ pid: optional(number), samples: number, peakRssMB: number, peakHeapMB: optional(number) }),
    100,
  ),
  writerHealth: optional(
    array(
      shape({
        pid: number,
        generation: string,
        at: date,
        dropped: number,
        overflowDrops: number,
        serializationFailures: number,
        writeFailures: number,
        lostLowerBound: number,
        checkpointFailures: number,
        logLevel: string,
        pluginLogEnabled: bool,
        closePolicy: enumOf('best_effort_sync_exit'),
      }),
      100,
    ),
  ),
  interpretation: string,
});
const coverage = shape({
  ...Object.fromEntries(
    'totalRunDirectories scannedRunDirectories includedRuns unreadableSummaries'.split(' ').map((key) => [key, number]),
  ),
  scanLimitReached: bool,
  runLimitReached: bool,
  directoryReadFailed: bool,
  windowStart: date,
  windowEnd: date,
  earliestRunStartedAt: optional(date),
  latestRunFinishedAt: optional(date),
});
const project = shape({
  version: enumOf(1),
  generatedAt: date,
  refreshAfterMs: number,
  classifierVersion: number,
  recording: shape({ enabled: bool, captureContent: bool }),
  totals: counters(
    'mainRuns delegatedRuns helperRuns running completed failed interrupted aborted paused requests tools toolErrors retries inputTokens outputTokens droppedEvents',
  ),
  progress: counters(
    'recentRecurring recentSingle historicalPending timeUnknown acceptedPending validatedWatching dismissed needsReview',
  ),
  coverage,
  toolHealthCoverage: counters('includedRuns excludedRuns unknownResults'),
  derivationCoverage: counters('limitedRuns callObservationsNotTracked findingSignalsNotRecorded unknownRuns'),
  limits: counters('runs findingsPerRun distinctCallKeysPerRun evidencePerFinding'),
  runs: array(
    shape({
      id: string,
      sessionTitle: nullable(string),
      workspaceKey: optional(string),
      source: enumOf('main', 'delegation', 'helper'),
      sourceLabel: string,
      providerId: string,
      model: string,
      outcome: enumOf('running', 'completed', 'aborted', 'error', 'interrupted', 'paused'),
      startedAt: date,
      finishedAt: optional(date),
      elapsedMs: optional(number),
      requestCount: number,
      toolCalls: number,
      toolErrors: number,
      retries: number,
      inputTokens: number,
      outputTokens: number,
      droppedEvents: number,
    }),
  ),
  findings: array(
    shape({
      id: string,
      kind: enumOf(
        'tool-error',
        'repeated-call',
        'run-error',
        'retry',
        'user-retry',
        'user-correction',
        'plugin-background',
      ),
      title: string,
      module: string,
      status: enumOf('open', 'accepted', 'dismissed', 'validated', 'regressed'),
      group: string,
      workspaceKey: optional(string),
      occurrences: number,
      recentOccurrences: optional(number),
      recentRuns: optional(number),
      firstSeenAt: optional(date),
      lastSeenAt: optional(date),
      reviewNeeded: optional(
        shape({ reason: enumOf('new-evidence', 'baseline-unavailable'), occurrences: number, runs: number }),
      ),
      suggestion: string,
      evaluation: string,
      note: optional(string),
      evidenceCount: number,
      evidence: array(shape({ runId: string, seq: number, available: bool }), 4),
    }),
  ),
  toolHealth: array(
    shape({
      name: string,
      calls: number,
      errors: number,
      errorRate: number,
      categories: array(shape({ category: string, count: number }), 3),
    }),
    60,
  ),
  pluginFailures: array(
    shape({ pluginId: string, ...identity, taskId: (value) => safeTaskId(String(string(value))), count: number, lastAt: date, lastError: () => '' }),
    100,
  ),
  plugins: array(
    shape({
      id: string,
      name: string,
      version: optional(string),
      enabled: bool,
      loading: enumOf('loaded', 'failed', 'skipped', 'unknown'),
      health: (value) =>
        value === null
          ? null
          : safeHealth(
              shape({
                level: enumOf('ok', 'warn', 'error'),
                category: optional(enumOf(...healthCategories)),
                versionKnown: optional(bool),
                at: date,
              })(value) as NonNullable<ConsolePlugin['health']>,
            ),
      operationStarts: number,
      operationFinishes: number,
      operationErrors: number,
      impressions: number,
      clicks: number,
    }),
    100,
  ),
  assembly: shape({ host: nullable(string), updatedAt: nullable(date), unreadable: bool }),
  logEvidence: nullable(logs),
  warnings: array(string, 40),
  counts: counters('runs findings toolHealth pluginFailures plugins warnings'),
  interpretation: string,
});

export async function readConsoleCache(
  root: string,
  classifier: number,
  signal: AbortSignal,
): Promise<ConsoleSnapshot | null> {
  let handle;
  try {
    signal.throwIfAborted();
    handle = await open(
      join(root, CONSOLE_CACHE_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    signal.throwIfAborted();
    if (size !== before.size || fileSignature(before) !== fileSignature(await handle.stat())) return null;
    const envelope = object(JSON.parse(buffer.toString('utf8', 0, size)));
    if (envelope.cacheVersion !== CONSOLE_CACHE_VERSION) return null;
    const value = project(envelope.snapshot) as ConsoleSnapshot;
    return value.classifierVersion === classifier ? value : null;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return null; // Derived, missing/damaged/old cache is disposable, never repaired by GET.
  } finally {
    await handle?.close();
  }
}

/** Called only by the existing recording/status publisher, never a GET service. */
export async function writeConsoleCache(root: string, snapshot: ConsoleSnapshot): Promise<void> {
  const data = JSON.stringify({ cacheVersion: CONSOLE_CACHE_VERSION, snapshot: project(snapshot) });
  if (Buffer.byteLength(data) > MAX_BYTES) return;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, CONSOLE_CACHE_FILE),
    temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
