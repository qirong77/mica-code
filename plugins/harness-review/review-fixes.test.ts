import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { expect, test, vi, type TestContext } from 'vitest';
import type { AgentObservationEvent, PluginObservationEvent } from '@packages/mica-plugin/index.js';
import type { PluginWebContext } from '@packages/mica-plugin/PluginWeb.js';
import { CLASSIFIER_VERSION, HarnessRecorder, type ReviewReport, type RunSummary } from './engine.js';
import { HarnessConsoleService, projectConsoleSnapshot } from './console.js';
import { CONSOLE_CACHE_FILE, readConsoleCache, writeConsoleCache } from './console-cache.js';
import { LogEvidenceReader } from './log-evidence.js';

const io = vi.hoisted(() => ({ active: 0, peak: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      io.active++;
      io.peak = Math.max(io.peak, io.active);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return await Reflect.apply(fs.stat, fs, args);
      } finally {
        io.active--;
      }
    },
  };
});

const at = '2026-11-19T10:00:00.000Z';
const config = { providerId: 'test', protocol: 'openai', model: 'test', effort: 'medium', role: 'main' };
const projection = {
  recording: { enabled: true, captureContent: false },
  plugins: [],
  assembly: { host: null, updatedAt: null, unreadable: false },
};
const line = (data: object) => JSON.stringify({ at, ...data }) + '\n';
const op = (data: object = {}) => ({
  scope: 'plugin-operation',
  event: 'operation.finish',
  plugin: 'sample',
  pluginVersion: '1.2.3',
  generation: 'process-a',
  pid: 42,
  operation: 'tool.execute',
  operationId: randomUUID(),
  surface: 'tool',
  outcome: 'success',
  ms: 10,
  ...data,
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mica-harness-fixes-'));
  vi.stubEnv('MICA_HOME', join(root, 'home'));
  vi.stubEnv('MICA_LOG_DIR', join(root, 'logs'));
  const data = join(root, 'capture');
  const recorder = new HarnessRecorder(data);
  t.onTestFinished(async () => {
    await recorder.dispose();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  const owner = {};
  const emit = (event: object) =>
    recorder.observe(
      { owner, runId: 1, timestamp: at, ...event } as AgentObservationEvent,
      { id: 'session', title: 'Safe title', cwd: '/workspace' },
      { captureContent: false, maxEventChars: 4000, maxEventsPerRun: 2000 },
    );
  return { root, data, recorder, emit };
}

async function lagged(t: TestContext) {
  const f = await fixture(t);
  f.emit({ type: 'run:start', config, input: 'INPUT-CANARY' });
  f.emit({ type: 'request:start', messageCount: 1 });
  f.emit({ type: 'request:end', durationMs: 10, attempts: 1, outcome: 'success' });
  await f.recorder.flush();
  const id = (await readdir(join(f.data, 'runs')))[0];
  const file = join(f.data, 'runs', id, 'summary.json');
  const summary = JSON.parse(await readFile(file, 'utf8')) as RunSummary;
  f.emit({ type: 'retry', attempt: 1, delayMs: 10, error: 'request timed out' });
  f.emit({ type: 'retry', attempt: 2, delayMs: 10, error: 'request timed out' });
  f.emit({ type: 'run:finish', outcome: 'aborted', elapsedMs: 125, timestamp: '2026-11-19T10:00:01.000Z' });
  await f.recorder.flush();
  summary.hostPid = 999_999_999;
  await writeFile(file, JSON.stringify(summary));
  return { ...f, file, summary };
}

test('OBS-01 dead-host recovery restores confirmed retry/finish/findings; Web projection leaves all run bytes unchanged', async (t) => {
  const { recorder, file, summary } = await lagged(t);
  const before = await readFile(file, 'utf8');
  const read = await recorder.review(undefined, { readOnly: true });
  expect(read.runs[0]).toMatchObject({
    eventCount: 6,
    retries: 2,
    outcome: 'aborted',
    finishedAt: '2026-11-19T10:00:01.000Z',
    elapsedMs: 125,
  });
  expect(read.findings.find((row) => row.kind === 'retry')).toMatchObject({
    occurrences: 2,
    title: 'Request retry: provider-timeout',
  });
  expect(read.findings[0].evidence.every((item) => item.available)).toBe(true);
  expect(await readFile(file, 'utf8')).toBe(before);
  expect(read.warnings.some((row) => row.includes('remains running'))).toBe(false);
  const maintained = await recorder.review();
  expect(maintained.runs[0].outcome).toBe('aborted');
  const saved = JSON.parse(await readFile(file, 'utf8')) as RunSummary;
  expect(saved).toMatchObject({ retries: 2, eventCount: 6, outcome: 'aborted' });
  expect(saved.findings[0].occurrences).toBe(2);
  expect(saved.startedAt).toBe(summary.startedAt);
  expect(await recorder.reclaim()).toBe(0);
});

for (const damage of ['gap', 'dropped', 'partial', 'missing'] as const)
  test(`OBS-01 ${damage} trace cannot fabricate a terminal result or lost retries`, async (t) => {
    const { recorder, file, summary } = await lagged(t);
    const trace = await readFile(summary.traceFile, 'utf8');
    if (damage === 'gap')
      await writeFile(
        summary.traceFile,
        trace
          .split('\n')
          .filter((_, i) => i !== 4)
          .join('\n'),
      );
    if (damage === 'partial') await writeFile(summary.traceFile, trace.trimEnd());
    if (damage === 'missing') await rm(summary.traceFile);
    if (damage === 'dropped') await writeFile(file, JSON.stringify({ ...summary, droppedEvents: 1 }));
    const report = await recorder.review();
    expect(report.runs[0]).toMatchObject({ outcome: 'interrupted', retries: 0 });
    expect(report.runs[0].finishedAt).toBeUndefined();
    expect(report.toolHealthCoverage.excludedRuns).toBe(1);
    expect(report.findings).toEqual([]);
    expect(report.warnings.join(' ')).toContain('unknown');
  });

test('OBS-01 continuous prefix can restore retry facts but never invents a finish; live hosts are not recovered', async (t) => {
  const { recorder, file, summary } = await lagged(t);
  const trace = await readFile(summary.traceFile, 'utf8');
  await writeFile(
    summary.traceFile,
    trace
      .split('\n')
      .filter((_, i) => i !== 5)
      .join('\n'),
  );
  await writeFile(file, JSON.stringify({ ...summary, hostPid: process.pid }));
  expect((await recorder.review(undefined, { readOnly: true })).runs[0].retries).toBe(0);
  await writeFile(file, JSON.stringify(summary));
  const report = await recorder.review();
  expect(report.runs[0]).toMatchObject({ outcome: 'interrupted', retries: 2, eventCount: 5 });
  expect(report.runs[0].finishedAt).toBeUndefined();
});

test('lossy paired trace cannot erase an error finding already confirmed by the complete summary', async (t) => {
  const { recorder, data, emit } = await fixture(t);
  emit({ type: 'run:start', config, input: 'safe task' });
  emit({ type: 'tool:call', name: 'read_file', args: '{}', id: 'good' });
  emit({ type: 'tool:result', name: 'read_file', result: 'safe result', id: 'good' });
  emit({ type: 'tool:call', name: 'read_file', args: '{}', id: 'bad' });
  emit({ type: 'tool:result', name: 'read_file', result: '{"isError":true,"message":"ENOENT: missing"}', id: 'bad' });
  emit({ type: 'run:finish', outcome: 'completed', elapsedMs: 10 });
  await recorder.flush();
  const id = (await readdir(join(data, 'runs')))[0];
  const file = join(data, 'runs', id, 'summary.json');
  const summary = JSON.parse(await readFile(file, 'utf8')) as RunSummary;
  expect(summary.findings.length).toBeGreaterThan(0);
  await writeFile(summary.traceFile, (await readFile(summary.traceFile, 'utf8')).split('\n').filter((row) => !row.includes('"id":"bad"')).join('\n'));
  await writeFile(file, JSON.stringify({ ...summary, droppedEvents: 2 }));
  const result = await recorder.review(undefined, { readOnly: true });
  expect(result.runs[0].toolErrors).toBe(summary.toolErrors);
  expect(result.runs[0].findings).toEqual(summary.findings);
  expect(result.toolHealthCoverage.excludedRuns).toBe(1);
});

test('OBS-02 Electron crashed/oom are confirmed crashes; killed and exit 15 remain neutral', async (t) => {
  const { root } = await fixture(t);
  await writeFile(
    join(root, 'electron.jsonl'),
    [
      { event: 'render-process-gone', reason: 'crashed', exitCode: 139 },
      { event: 'child-process-gone', reason: 'oom', exitCode: 1 },
      { event: 'render-process-gone', reason: 'killed', exitCode: 15 },
      { event: 'child-process-gone', reason: 'killed', exitCode: 1 },
      { event: 'child-process-gone', reason: 'crashed', exitCode: 15 },
    ]
      .map((data) => line({ scope: 'electron', level: 'error', ...data }))
      .join(''),
  );
  const report = await new LogEvidenceReader().read(root);
  expect(report.totals?.crashes).toBe(2);
});

test('OBS-03 full inspected totals survive 100 display groups and error/unknown groups sort before successes', async (t) => {
  const { root } = await fixture(t);
  await writeFile(
    join(root, 'operations.jsonl'),
    Array.from({ length: 110 }, (_, i) => line(op({ operation: `success-${i}` }))).join('') +
      line(op({ outcome: 'error', operation: 'last-error' })) +
      line(op({ event: 'operation.start', outcome: undefined, operation: 'unfinished' })),
  );
  const report = await new LogEvidenceReader().read(root);
  expect(report.operations).toHaveLength(100);
  expect(report.coverage.groups?.operations).toBe(112);
  expect(report.coverage.groupLimitReached).toBe(true);
  expect(report.totals).toMatchObject({ operationFinishes: 111, operationErrors: 1, operationUnknown: 1 });
  expect(report.operations.slice(0, 2).map((row) => row.outcome)).toEqual(['error', 'unknown']);
  expect(report.pluginTotals?.[0]).toMatchObject({ plugin: 'sample', operationFinishes: 111, operationErrors: 1 });
});

test('OBS-06 ordinary plugin warning/error groups retain original version and process generation; history is unknown', async (t) => {
  const { root } = await fixture(t);
  await writeFile(
    join(root, 'plugin.jsonl'),
    [
      { pluginId: 'first', pluginVersion: '1.0', pid: 42, generation: 'old' },
      { pluginId: 'second', pluginVersion: '2.0', pid: 42, generation: 'new' },
      { pluginId: 'first' },
    ]
      .map((data) =>
        line({
          scope: 'plugin',
          level: 'warn',
          event: 'background-failed',
          ...data,
          error: 'RAW-ERROR-CANARY /private/path https://private.invalid',
        }),
      )
      .join(''),
  );
  const report = await new LogEvidenceReader().read(root);
  expect(report.system).toHaveLength(3);
  expect(report.system.find((row) => row.pluginId === 'second')).toMatchObject({
    pluginVersion: '2.0',
    pid: 42,
    generation: 'new',
  });
  expect(report.system.find((row) => row.pluginId === 'first' && row.pid === undefined)).toMatchObject({
    pluginVersion: 'unknown',
    generation: 'unknown',
  });
  expect(JSON.stringify(report)).not.toMatch(/CANARY|private.invalid|\/private\/path/);
});

test('OBS-08 metadata selection inspects more than 512 names with at most 16 concurrent stats, selecting the newest domain', async (t) => {
  const { root } = await fixture(t);
  for (let start = 0; start < 530; start += 20)
    await Promise.all(
      Array.from({ length: Math.min(20, 530 - start) }, async (_, index) => {
        const file = join(root, `zz-${start + index}.jsonl`);
        await writeFile(file, '');
        await utimes(file, new Date('2020-01-01'), new Date('2020-01-01'));
      }),
    );
  await writeFile(join(root, 'a-newest.jsonl'), line(op({ outcome: 'error' })));
  io.peak = 0;
  const report = await new LogEvidenceReader().read(root);
  expect(report.coverage).toMatchObject({
    candidateFiles: 531,
    metadataFiles: 531,
    scannedFiles: 64,
    selection: 'mtime',
  });
  expect(io.peak).toBeLessThanOrEqual(16);
  expect(report.totals?.operationErrors).toBe(1);
});

test('merged background heartbeats and cumulative writer checkpoints preserve lower bounds without duplicating copied windows', async (t) => {
  const { root } = await fixture(t);
  const heartbeat = line({
    scope: 'plugin-heartbeat',
    event: 'background.heartbeat',
    heartbeatId: randomUUID(),
    schemaVersion: 1,
    plugin: 'sample',
    pluginVersion: '1',
    operation: 'background.tick',
    taskId: 'poll',
    pid: 42,
    generation: 'a',
    outcome: 'success',
    code: 'ok',
    count: 40,
    totalMs: 400,
    maxMs: 10,
    firstAt: Date.parse(at),
    lastAt: Date.parse(at) + 100,
    windowStart: Date.parse(at),
    windowEnd: Date.parse(at) + 60000,
    durationBoundsMs: [10, 100, 1000, 10000],
    durationBuckets: [0, 40, 0, 0, 0],
  });
  const writer = {
    scope: 'writer-health',
    event: 'writer.checkpoint',
    schemaVersion: 1,
    pid: 42,
    generation: 'a',
    dropped: 7,
    overflowDrops: 5,
    serializationFailures: 2,
    writeFailures: 4,
    lostLowerBound: 7,
    checkpointFailures: 1,
    logLevel: 'info',
    pluginLogEnabled: true,
    closePolicy: 'best_effort_sync_exit',
    error: 'RAW-ERROR-CANARY',
  };
  await writeFile(
    join(root, 'one.jsonl'),
    heartbeat + line(writer) + line({ ...writer, dropped: 2, lostLowerBound: 2 }),
  );
  await writeFile(join(root, 'copy.jsonl'), heartbeat);
  const report = await new LogEvidenceReader().read(root);
  expect(report.totals).toMatchObject({ operationStarts: 40, operationFinishes: 40, operationErrors: 0 });
  expect(report.operations[0]).toMatchObject({
    heartbeatCount: 40,
    totalMs: 400,
    maxMs: 10,
    durationBuckets: [0, 40, 0, 0, 0],
  });
  expect(report.coverage).toMatchObject({ heartbeatRecords: 1, heartbeatCount: 40, writerHealthObserved: true });
  expect(report.writerHealth).toHaveLength(1);
  expect(report.writerHealth?.[0]).toMatchObject({ lostLowerBound: 7, writeFailures: 4, generation: 'a' });
  expect(JSON.stringify(report)).not.toContain('CANARY');
});

test('same-time heartbeat flushes retain separate counts and preserve skipped/waiting outcomes', async (t) => {
  const { root } = await fixture(t);
  const base = { scope: 'plugin-heartbeat', event: 'background.heartbeat', schemaVersion: 1,
    plugin: 'neutral', pluginVersion: '1', operation: 'background.tick', taskId: 'poll', pid: 42, generation: 'a',
    count: 3, totalMs: 0, maxMs: 0, firstAt: Date.parse(at), lastAt: Date.parse(at),
    windowStart: Date.parse(at), windowEnd: Date.parse(at) + 60000,
    durationBoundsMs: [10, 100, 1000, 10000], durationBuckets: [3, 0, 0, 0, 0] };
  const records = ['skipped', 'skipped', 'waiting'].map((outcome) => line({ ...base, outcome, code: outcome,
    heartbeatId: randomUUID() }));
  await writeFile(join(root, 'neutral.jsonl'), records.join('') + records[0]);
  const report = await new LogEvidenceReader().read(root);
  expect(report.totals).toMatchObject({ operationStarts: 9, operationFinishes: 9, operationErrors: 0 });
  expect(report.operations.find((row) => row.outcome === 'skipped')?.finishes).toBe(6);
  expect(report.operations.find((row) => row.outcome === 'waiting')?.finishes).toBe(3);
});

test('plugin failure profiles keep trustworthy identity, sum distinct generations for stable task findings and never backfill history', async (t) => {
  const { recorder, data } = await fixture(t);
  for (const [generation, pluginVersion] of [
    ['old', '1'],
    ['new', '2'],
  ])
    recorder.notePluginEvent({
      schemaVersion: 2,
      type: 'background:failed',
      timestamp: at,
      pluginId: 'sample',
      pluginVersion,
      pid: 42,
      generation,
      taskId: 'poll',
      tick: 3,
      failures: 3,
      error: 'raw failure',
    } as PluginObservationEvent);
  await recorder.flush();
  const report = await recorder.review(undefined, { readOnly: true });
  expect(report.pluginFailures).toHaveLength(2);
  expect(report.pluginFailures.map((row) => row.pluginVersion).sort()).toEqual(['1', '2']);
  expect(report.findings.find((row) => row.kind === 'plugin-background')?.occurrences).toBe(6);
  const file = join(data, 'plugin-events.jsonl');
  await writeFile(
    file,
    line({
      schemaVersion: 2,
      pluginId: 'sample',
      pluginVersion: 'unknown',
      generation: 'unknown',
      taskId: 'poll',
      failures: 3,
      error: 'RAW-CANARY',
    }),
  );
  expect((await recorder.review(undefined, { readOnly: true })).pluginFailures[0]).toMatchObject({
    pluginVersion: 'unknown',
    generation: 'unknown',
  });
});

test('SEC-01 health/error projections use fixed categories, never diagnostic paths, URLs or canaries', async (t) => {
  const { recorder, root } = await fixture(t);
  const report = await recorder.review(undefined, { readOnly: true });
  const ctx: PluginWebContext = {
    pluginId: 'harness-review',
    pluginVersion: '1',
    catalog: [{ id: 'sample', name: 'Sample', version: '1' }],
    paths: { config: join(root, 'config'), data: join(root, 'capture') },
    settings: { get: () => ({}) },
  };
  await mkdir(join(ctx.paths.config, 'plugin-health'), { recursive: true });
  await writeFile(
    join(ctx.paths.config, 'plugin-health', 'sample.json'),
    JSON.stringify({
      schemaVersion: 2,
      issues: {
        'background:poll': {
          issueKey: 'background:poll',
          level: 'error',
          at,
          version: '1',
          message: 'RAW-ERROR-CANARY /private/path https://private.invalid',
          hint: 'secret hint',
        },
      },
    }),
  );
  const service = new HarnessConsoleService(ctx, { readReport: async () => report });
  t.onTestFinished(() => service.dispose());
  const value = await service.snapshot();
  expect(value.plugins[0].health).toMatchObject({ category: 'background', level: 'error', versionKnown: true });
  expect(JSON.stringify(value)).not.toMatch(/CANARY|\/private\/path|private.invalid|secret hint/);
  const bad = new HarnessConsoleService(ctx, {
    readReport: async () => {
      throw new Error('RAW-ERROR-CANARY /private/path https://private.invalid');
    },
  });
  t.onTestFinished(() => bad.dispose());
  await expect(bad.snapshot()).rejects.toThrow('运行控制台数据暂不可用');
});

test('PERF-01 a cold service returns a versioned safe persistent snapshot before its slow refresh, without any GET writes', async (t) => {
  const { recorder, data, root } = await fixture(t);
  const report = await recorder.review(undefined, { readOnly: true });
  const snapshot = projectConsoleSnapshot(report, projection);
  snapshot.generatedAt = at;
  await writeConsoleCache(data, snapshot);
  const file = join(data, CONSOLE_CACHE_FILE),
    before = await readFile(file, 'utf8');
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  let release!: (report: ReviewReport) => void;
  const readReport = vi.fn(
    () =>
      new Promise<ReviewReport>((resolve) => {
        release = resolve;
      }),
  );
  const ctx: PluginWebContext = {
    pluginId: 'harness-review',
    pluginVersion: '1',
    catalog: [],
    paths: { config: join(root, 'config'), data },
    settings: { get: () => ({}) },
  };
  const service = new HarnessConsoleService(ctx, {
    readReport,
    usePersistentCache: true,
    now: () => Date.parse(at) + 60000,
  });
  const value = await service.snapshot();
  expect(value).toMatchObject({ generatedAt: at, cache: { source: 'persistent', stale: true } });
  await tick();
  expect(readReport).toHaveBeenCalledTimes(1);
  release(report);
  await vi.waitFor(async () => expect((await service.snapshot()).cache?.source).toBe('live'));
  await service.dispose();
  expect(await readFile(file, 'utf8')).toBe(before);
  expect(await readdir(data)).toEqual([CONSOLE_CACHE_FILE]);
  expect(await readConsoleCache(data, CLASSIFIER_VERSION + 1, new AbortController().signal)).toBeNull();
  await writeFile(file, '{corrupt-cache');
  expect(await readConsoleCache(data, CLASSIFIER_VERSION, new AbortController().signal)).toBeNull();
  expect(await readFile(file, 'utf8')).toBe('{corrupt-cache');
  await rm(file);
  await symlink(join(root, 'outside'), file);
  expect(await readConsoleCache(data, CLASSIFIER_VERSION, new AbortController().signal)).toBeNull();
});
