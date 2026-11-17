import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { test, vi, type TestContext } from 'vitest';
import type { PluginWebContext } from '@packages/mica-plugin/PluginWeb.js';
import { CONSOLE_MAX_BYTES, CONSOLE_TTL_MS, HarnessConsoleService, projectConsoleSnapshot } from './console.js';
import type { ConsolePlugin } from './console-types.js';
import type { ReviewReport, RunSummary } from './engine.js';
import type { LogEvidence } from './log-evidence.js';

const at = '2026-11-01T12:00:00.000Z';
function run(index = 0): RunSummary {
  return {
    version: 1,
    id: `run-${index}`,
    sourceRunId: index,
    sessionId: 'session',
    sessionTitle: 'Safe title',
    cwd: '/workspace',
    config: { providerId: 'provider', model: 'model', protocol: 'openai', effort: 'medium', role: 'main' },
    outcome: 'completed',
    startedAt: at,
    finishedAt: at,
    elapsedMs: 1,
    requestCount: 2,
    toolCalls: 3,
    toolErrors: 1,
    expectedExits: 0,
    retries: 1,
    compactions: { local: 0, llm: 0, idle: 0 },
    inputTokens: 4,
    outputTokens: 5,
    cachedInputTokens: 0,
    droppedEvents: 1,
    eventCount: 1,
    traceFile: '/private/runs/run/events.jsonl',
    promptHashes: [],
    findings: [],
  };
}
function report(): ReviewReport {
  return {
    version: 1,
    root: '/private/harness',
    generatedAt: at,
    runs: [],
    findings: [],
    delegation: { parents: [] },
    helpers: { total: 0, kinds: [] },
    pluginFailures: [],
    toolHealth: [],
    warnings: [],
    scannedRuns: 0,
    coverage: {
      totalRunDirectories: 0,
      scannedRunDirectories: 0,
      includedRuns: 0,
      scanLimitReached: false,
      runLimitReached: false,
      unreadableSummaries: 0,
      directoryReadFailed: false,
      windowStart: at,
      windowEnd: at,
    },
    toolHealthCoverage: { includedRuns: 0, excludedRuns: 0, unknownResults: 0 },
    derivationCoverage: { limitedRuns: 0, callObservationsNotTracked: 0, findingSignalsNotRecorded: 0, unknownRuns: 0 },
    limits: { runs: 2000, findingsPerRun: 100, distinctCallKeysPerRun: 1000, evidencePerFinding: 20 },
    interpretation: 'Not copied',
  };
}
function logs(): LogEvidence {
  return {
    scope: 'machine',
    coverage: {
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
    },
    operations: [],
    experience: [],
    memory: [],
    system: [],
    interpretation: 'Not copied',
  };
}
function context(root: string): PluginWebContext {
  return {
    pluginId: 'harness-review',
    pluginVersion: '0.1.0',
    paths: { config: join(root, 'config'), data: join(root, 'data') },
    settings: { get: () => ({ enabled: 'true', captureContent: 'false', apiKey: 'SETTINGS-SECRET-CANARY' }) },
    catalog: [],
  };
}
const projection = {
  recording: { enabled: true, captureContent: false },
  plugins: [],
  assembly: { host: null, updatedAt: null, unreadable: false },
};

test('an empty complete projection has no invented warning', () => {
  const result = projectConsoleSnapshot(report(), projection);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.counts.warnings, 0);
});
async function temporary(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mica-harness-console-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('console is a whitelist, not a serialized report/run/error/trace or settings document', () => {
  const source = report();
  const item = run();
  item.error = 'ERROR-RAW-CANARY';
  item.input = { sha256: 'hash', chars: 1, excerpt: 'INPUT-CANARY' };
  item.promptHashes = [{ sha256: 'PROMPT-CANARY', chars: 1 }];
  Object.assign(item.config, { apiKey: 'PROVIDER-KEY-CANARY' });
  Object.assign(item, { arbitrary: 'EXTRA-CANARY' });
  source.runs = [item];
  source.findings = [
    {
      id: 'finding',
      kind: 'plugin-background',
      title: 'Plugin signal',
      module: 'plugin:sample',
      suggestion: 'Check configuration',
      evaluation: 'ERROR-RAW-CANARY',
      note: 'apiKey=NOTE-SECRET-CANARY',
      status: 'open',
      occurrences: 1,
      evidence: [{ runId: item.id, seq: 1, available: true, traceFile: item.traceFile, detail: 'DETAIL-CANARY' }],
      assessments: [{ status: 'accepted', note: 'HISTORY-CANARY', updatedAt: at }],
    },
  ];
  source.pluginFailures = [{ pluginId: 'sample', taskId: 'poll', count: 3, lastAt: at, lastError: 'ERROR-RAW-CANARY' }];
  source.warnings = [`Run has missing or unreadable trace: ${item.traceFile}`];
  const result = projectConsoleSnapshot(source, projection);
  const json = JSON.stringify(result);
  for (const canary of [
    'ERROR-RAW-CANARY',
    'INPUT-CANARY',
    'PROMPT-CANARY',
    'PROVIDER-KEY-CANARY',
    'EXTRA-CANARY',
    'NOTE-SECRET-CANARY',
    'DETAIL-CANARY',
    'HISTORY-CANARY',
    'events.jsonl',
    'traceFile',
    '/private/harness',
  ])
    assert.ok(!json.includes(canary), canary);
  assert.equal(result.pluginFailures[0].lastError, '');
  assert.deepEqual(result.findings[0].evidence, [{ runId: item.id, seq: 1, available: true }]);
  assert.equal(result.findings[0].evidenceCount, 1);
});

test('totals cover every run, while main/delegation/helper source labels use real kind/type', () => {
  const source = report();
  source.runs = [
    run(0),
    { ...run(1), delegation: { type: 'Explorer' }, outcome: 'interrupted' },
    { ...run(2), helper: { kind: 'compaction', purpose: 'PURPOSE-CANARY' }, outcome: 'paused' },
  ];
  const result = projectConsoleSnapshot(source, projection);
  assert.deepEqual(
    result.runs.map(({ source, sourceLabel }) => [source, sourceLabel]),
    [
      ['main', 'main'],
      ['delegation', 'Explorer'],
      ['helper', 'compaction'],
    ],
  );
  assert.deepEqual(result.totals, {
    mainRuns: 1,
    delegatedRuns: 1,
    helperRuns: 1,
    running: 0,
    completed: 1,
    failed: 0,
    interrupted: 1,
    aborted: 0,
    paused: 1,
    requests: 6,
    tools: 9,
    toolErrors: 3,
    retries: 3,
    inputTokens: 12,
    outputTokens: 15,
    droppedEvents: 3,
  });
  assert.ok(!JSON.stringify(result).includes('PURPOSE-CANARY'));
});

test('extreme UTF-8 payload shrinks optional arrays below 900 KiB, preserving full totals/counts and priority', () => {
  const source = report();
  const long = '界'.repeat(30_000);
  source.runs = Array.from({ length: 450 }, (_, i) => ({
    ...run(i),
    sessionTitle: long,
    cwd: long,
    config: { ...run().config, providerId: long, model: long },
  }));
  source.findings = Array.from({ length: 350 }, (_, i) => ({
    id: `finding-${i}`,
    kind: 'tool-error',
    title: long,
    module: long,
    cwd: long,
    suggestion: long,
    evaluation: long,
    note: long,
    status: 'open',
    occurrences: 350 - i,
    recentOccurrences: i === 349 ? 10 : 0,
    evidence: Array.from({ length: 20 }, (_, seq) => ({
      runId: `run-${i}`,
      seq,
      available: true,
      traceFile: '/not-returned/events.jsonl',
    })),
  }));
  source.toolHealth = Array.from({ length: 90 }, (_, i) => ({
    name: `tool-${i}`,
    calls: 1,
    errors: 1,
    errorRate: 1,
    categories: [{ category: long, count: 1 }],
  }));
  source.pluginFailures = Array.from({ length: 150 }, (_, i) => ({
    pluginId: `plugin-${i}`,
    taskId: long,
    count: i,
    lastAt: at,
    lastError: long,
  }));
  source.warnings = Array.from({ length: 80 }, () => long);
  const plugins: ConsolePlugin[] = Array.from({ length: 140 }, (_, i) => ({
    id: `plugin-${i}`,
    name: long,
    version: long,
    enabled: true,
    loading: 'unknown',
    health: { level: 'warn', at, message: long },
    operationStarts: 0,
    operationFinishes: 0,
    operationErrors: 0,
    impressions: 0,
    clicks: 0,
  }));
  const result = projectConsoleSnapshot(source, { ...projection, plugins });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= CONSOLE_MAX_BYTES);
  assert.deepEqual(result.counts, {
    runs: 450,
    findings: 350,
    toolHealth: 90,
    pluginFailures: 150,
    plugins: 140,
    warnings: 81,
  });
  assert.ok(
    result.runs.length <= 200 &&
      result.findings.length <= 200 &&
      result.toolHealth.length <= 60 &&
      result.plugins.length <= 100 &&
      result.pluginFailures.length <= 100 &&
      result.warnings.length <= 40,
  );
  assert.equal(result.findings[0].id, 'finding-349');
  assert.equal(result.totals.requests, 900);
  assert.equal(result.totals.tools, 1350);
  assert.equal(result.totals.inputTokens, 1800);
  assert.equal(result.progress.recentRecurring, 1);
  assert.equal(result.progress.historicalPending, 349);
  assert.match(result.warnings[0], /展示省略：runs=\d+, findings=\d+/);
  assert.match(result.warnings[0], new RegExp(`findings=${350 - result.findings.length}`));
  assert.ok(result.findings[0].evidence.length <= 4);
  assert.equal(result.findings[0].evidenceCount, 20);
});

test('one lazy snapshot is shared for a full 30s TTL; cancelling one waiter does not cancel another', async (t) => {
  const root = await temporary(t);
  const gate = deferred<ReviewReport>();
  let now = 0;
  let scanSignal: AbortSignal | undefined;
  const readReport = vi.fn((signal: AbortSignal) => {
    scanSignal = signal;
    return gate.promise;
  });
  const service = new HarnessConsoleService(context(root), { now: () => now, readReport });
  t.onTestFinished(() => service.dispose());
  assert.equal(readReport.mock.calls.length, 0);
  assert.deepEqual(await readdir(root), []);
  const first = new AbortController();
  const one = service.snapshot(first.signal);
  const oneRejected = assert.rejects(one, { name: 'AbortError' });
  const two = service.snapshot();
  await tick();
  first.abort();
  await oneRejected;
  assert.equal(scanSignal!.aborted, false);
  gate.resolve(report());
  const value = await two;
  assert.equal(readReport.mock.calls.length, 1);
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.runs));
  now = CONSOLE_TTL_MS - 1;
  for (let i = 0; i < 10; i++) assert.equal(await service.snapshot(), value);
  assert.equal(readReport.mock.calls.length, 1);
  now = CONSOLE_TTL_MS;
  assert.notEqual(await service.snapshot(), value);
  assert.equal(readReport.mock.calls.length, 2);
  assert.deepEqual(await readdir(root), []);
});

test('failed scans are not cached and the next request retries once', async (t) => {
  const root = await temporary(t);
  const readReport = vi
    .fn<(_: AbortSignal) => Promise<ReviewReport>>()
    .mockRejectedValueOnce(new Error('scan failed'))
    .mockResolvedValue(report());
  const service = new HarnessConsoleService(context(root), { readReport });
  t.onTestFinished(() => service.dispose());
  await assert.rejects(service.snapshot(), /scan failed/);
  await service.snapshot();
  await service.snapshot();
  assert.equal(readReport.mock.calls.length, 2);
});

test('all-waiter cancellation aborts the scan; cancelled drain waiters never trigger orphan rescans', async (t) => {
  const root = await temporary(t);
  const gate = deferred<ReviewReport>();
  let scanSignal: AbortSignal | undefined;
  let calls = 0;
  const readReport = vi.fn((signal: AbortSignal) => {
    scanSignal = signal;
    return ++calls === 1 ? gate.promise : Promise.resolve(report());
  });
  const service = new HarnessConsoleService(context(root), { readReport });
  t.onTestFinished(() => service.dispose());
  const a = new AbortController(),
    b = new AbortController(),
    c = new AbortController();
  const one = assert.rejects(service.snapshot(a.signal), { name: 'AbortError' });
  const two = assert.rejects(service.snapshot(b.signal), { name: 'AbortError' });
  await tick();
  a.abort();
  b.abort();
  await Promise.all([one, two]);
  assert.equal(scanSignal!.aborted, true);
  const drain = assert.rejects(service.snapshot(c.signal), { name: 'AbortError' });
  c.abort();
  await drain;
  gate.resolve(report());
  await tick();
  assert.equal(readReport.mock.calls.length, 1);
  await service.snapshot();
  assert.equal(readReport.mock.calls.length, 2);
});

test('dispose aborts clients immediately and prevents a late scan result being published', async (t) => {
  const root = await temporary(t);
  const gate = deferred<ReviewReport>();
  const readReport = vi.fn(() => gate.promise);
  const service = new HarnessConsoleService(context(root), { readReport });
  const pending = assert.rejects(service.snapshot(), { name: 'AbortError' });
  await tick();
  service.dispose();
  await pending;
  gate.resolve(report());
  await tick();
  await assert.rejects(service.snapshot(), { name: 'AbortError' });
  assert.equal(readReport.mock.calls.length, 1);
});

test('dispose does not finish until the cancelled underlying reader has drained', async (t) => {
  const root = await temporary(t);
  const gate = deferred<ReviewReport>();
  const service = new HarnessConsoleService(context(root), { readReport: () => gate.promise });
  const pending = assert.rejects(service.snapshot(), { name: 'AbortError' });
  await tick();
  let stopped = false;
  const disposal = service.dispose().then(() => {
    stopped = true;
  });
  await pending;
  assert.equal(stopped, false);
  gate.resolve(report());
  await disposal;
  assert.equal(stopped, true);
});

test('plugin inventory joins catalog, last assembly, log observations and failures without claiming live loading', async (t) => {
  const root = await temporary(t);
  const ctx = context(root);
  ctx.catalog = [
    { id: 'sample', name: 'Sample', version: '2.0.0' },
    { id: 'fresh', name: 'Fresh', version: '1.0.0' },
  ];
  await mkdir(join(ctx.paths.config, 'plugin-health'), { recursive: true });
  await writeFile(join(ctx.paths.config, 'plugins-state.json'), JSON.stringify({ disabled: ['sample'] }));
  await writeFile(
    join(ctx.paths.config, 'plugin-status.json'),
    JSON.stringify({
      host: 'tui',
      updatedAt: at,
      root: '/PRIVATE-ROOT-CANARY',
      plugins: [
        { id: 'sample', status: 'skipped', error: 'STATUS-ERROR-CANARY', file: '/FILE-CANARY' },
        { id: 'user.custom', status: 'loaded' },
      ],
      loadFailed: [{ file: 'FILE-CANARY', error: 'STATUS-ERROR-CANARY' }],
    }),
  );
  for (const [id, version] of [
    ['sample', '1.0.0'],
    ['user.custom', '7.0.0'],
  ])
    await writeFile(
      join(ctx.paths.config, 'plugin-health', `${id}.json`),
      JSON.stringify({
        schemaVersion: 2,
        issues: { runtime: { issueKey: 'runtime', level: 'warn', at, version, message: 'Needs configuration' } },
      }),
    );
  const source = report();
  source.logEvidence = logs();
  source.logEvidence.operations = ['error', 'timeout', 'cancelled', 'busy', 'success'].map((outcome, i) => ({
    plugin: 'log-only',
    operation: 'tool',
    outcome,
    starts: i + 1,
    finishes: i + 1,
    totalMs: 0,
    maxMs: 0,
  }));
  source.logEvidence.operations.push({
    plugin: 'log-only',
    operation: 'unfinished',
    outcome: 'error',
    starts: 10,
    finishes: 0,
    totalMs: 0,
    maxMs: 0,
  });
  source.logEvidence.experience = [
    { plugin: 'log-only', pluginVersion: '1', event: 'impression', records: 1, count: 4 },
    { plugin: 'log-only', pluginVersion: '1', event: 'click', records: 2, count: 2 },
  ];
  source.pluginFailures = [
    { pluginId: 'failure-only', taskId: 'poll', count: 9, lastAt: at, lastError: 'ERROR-CANARY' },
  ];
  const service = new HarnessConsoleService(ctx, { readReport: async () => source });
  t.onTestFinished(() => service.dispose());
  const result = await service.snapshot();
  assert.equal(result.counts.plugins, 5);
  assert.deepEqual(result.assembly, { host: 'tui', updatedAt: at, unreadable: false });
  const sample = result.plugins.find((row) => row.id === 'sample')!;
  assert.equal(sample.enabled, false);
  assert.equal(sample.loading, 'skipped');
  assert.equal(sample.version, '2.0.0');
  assert.equal(sample.health, null, 'old-version health must not be applied to the known new manifest');
  const custom = result.plugins.find((row) => row.id === 'user.custom')!;
  assert.equal(custom.version, undefined);
  assert.match(custom.health!.message, /上次上报.*版本未知/);
  assert.equal(result.plugins.find((row) => row.id === 'fresh')!.loading, 'unknown');
  const observed = result.plugins.find((row) => row.id === 'log-only')!;
  assert.equal(observed.operationErrors, 3, 'only error and timeout finishes are errors');
  assert.equal(observed.operationStarts, 25);
  assert.equal(observed.operationFinishes, 15);
  assert.equal(observed.impressions, 4);
  assert.equal(observed.clicks, 2);
  assert.equal(result.logEvidence!.operations.at(-1)!.outcome, 'unknown');
  for (const secret of ['CANARY', '/PRIVATE-ROOT', 'apiKey']) assert.ok(!JSON.stringify(result).includes(secret));
});

test('corrupt or oversized assembly is explicitly unreadable, not a default loaded state', async (t) => {
  const root = await temporary(t);
  const ctx = context(root);
  ctx.catalog = [{ id: 'sample', name: 'Sample', version: '1.0.0' }];
  await mkdir(ctx.paths.config);
  for (const bytes of [
    '{not-json',
    '{}',
    ' '.repeat(1024 * 1024 + 1),
    JSON.stringify({ host: 'tui', updatedAt: at, plugins: [{ id: '../escape', status: 'loaded' }] }),
  ]) {
    await writeFile(join(ctx.paths.config, 'plugin-status.json'), bytes);
    const service = new HarnessConsoleService(ctx, { readReport: async () => report() });
    const result = await service.snapshot();
    service.dispose();
    assert.equal(result.assembly.unreadable, true);
    assert.equal(result.assembly.host, null);
    assert.equal(result.plugins[0].loading, 'unknown');
    assert.ok(result.warnings.some((line) => /assembly snapshot/.test(line)));
  }
});

test('the default read service returns a real empty state without creating any data directories', async (t) => {
  const root = await temporary(t);
  vi.stubEnv('MICA_LOG_DIR', join(root, 'logs'));
  t.onTestFinished(() => vi.unstubAllEnvs());
  const ctx = context(root);
  const service = new HarnessConsoleService(ctx);
  t.onTestFinished(() => service.dispose());
  assert.deepEqual(await readdir(root), []);
  const result = await service.snapshot();
  assert.equal(result.counts.runs, 0);
  assert.equal(result.totals.mainRuns, 0);
  assert.equal(result.coverage.directoryReadFailed, false);
  assert.equal(result.assembly.unreadable, false);
  assert.equal(result.logEvidence!.coverage.scannedFiles, 0);
  assert.equal(result.recording.captureContent, false);
  service.dispose();
  assert.deepEqual(await readdir(root), []);
});
