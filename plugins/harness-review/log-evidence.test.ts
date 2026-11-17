import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { HarnessRecorder } from './engine.js';
import { ProjectionIndex } from './derived-index.js';
import { LogEvidenceReader } from './log-evidence.js';
import { LIST_MAX_CHARS, summarizeList } from './list.js';

async function fixture(t: { onTestFinished: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'mica-harness-log-evidence-'));
  vi.stubEnv('MICA_LOG_DIR', directory);
  vi.stubEnv('MICA_HOME', join(directory, 'home'));
  t.onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
const at = 1793808000000;
const line = (fields: object) => JSON.stringify({ at, ...fields }) + '\n';
const operation = (fields: object = {}) => ({
  scope: 'plugin-operation',
  event: 'operation.finish',
  plugin: 'sample',
  pluginVersion: '1.2.3',
  operationId: randomUUID(),
  operation: 'tool.execute',
  surface: 'tool',
  outcome: 'success',
  code: 'ok',
  ms: 10,
  pid: 42,
  ...fields,
});

test('whitelist log projections read real top-level operation and nested schema-1 experience fields only', async (t) => {
  const dir = await fixture(t);
  const secret = 'private body /private/path https://private.invalid command --secret error-original';
  const op = operation();
  await writeFile(
    join(dir, 'runtime-20261105.jsonl'),
    line({ ...op, input: secret, error: secret, data: { plugin: 'wrong', operation: secret } }) +
      line({ ...op, event: 'operation.start', outcome: undefined, code: undefined }) +
      line(operation({ outcome: 'busy', code: 'busy' })) +
      line(operation({ outcome: 'error', code: 'returned_error' })) +
      line({
        scope: 'plugin',
        pluginId: 'sample',
        plugin: 'wrong-plugin',
        event: 'plugin:experience',
        data: {
          schemaVersion: 1,
          eventId: randomUUID(), pluginVersion: '1.2.3',
          event: 'click',
          surface: 'panel',
          action: 'open-review',
          outcome: 'success',
          count: 3,
          body: secret,
          error: secret,
        },
      }) +
      JSON.stringify({
        time: new Date(at).toISOString(),
        plugin: 'legacy',
        event: 'plugin:experience',
        data: { schemaVersion: 1, eventId: randomUUID(), pluginVersion: '1.0.0', event: 'check', surface: 'page', action: 'refresh', count: 2 },
      }) +
      '\n' +
      line({
        scope: 'plugin',
        pluginId: 'sample',
        event: 'plugin:experience',
        data: { schemaVersion: 2, event: 'click' },
      }) +
      line({
        scope: 'plugin',
        pluginId: 'sample',
        event: 'plugin:experience',
        data: { schemaVersion: 1, event: 'body event', action: secret },
      }) +
      line({
        scope: 'host',
        event: 'host.warn',
        level: 'warn',
        message: secret,
        error: { message: secret },
        path: secret,
      }) +
      line({ scope: 'mem', event: 'sample', pid: 42, rss: 512, heap: 128, input: secret }) +
      line({ scope: 'mem', event: 'sample', pid: 42, rss: 256, heap: 256 }),
  );
  // Duplicated operation IDs across inspected files do not double-count starts/finishes.
  await writeFile(join(dir, 'duplicate-20261105.jsonl'), line(op));
  const reader = new LogEvidenceReader();
  const report = await reader.read(dir);
  expect(report.operations.reduce((n, item) => n + item.finishes, 0)).toBe(3);
  expect(report.operations.find((item) => item.outcome === 'busy')).toMatchObject({ finishes: 1, code: 'busy' });
  expect(report.operations.find((item) => item.outcome === 'success')).toMatchObject({ starts: 1, finishes: 1 });
  expect(report.operations.some((item) => item.outcome === 'unknown')).toBe(false);
  expect(report.experience).toContainEqual({
    plugin: 'sample',
    pluginVersion: '1.2.3',
    event: 'click',
    surface: 'panel',
    action: 'open-review',
    outcome: 'success',
    records: 1,
    count: 3,
  });
  expect(report.experience.some((item) => item.plugin === 'legacy')).toBe(true);
  expect(report.experience.some((item) => item.plugin === 'wrong-plugin')).toBe(false);
  expect(report.memory).toEqual([{ pid: 42, samples: 2, peakRssMB: 512, peakHeapMB: 256 }]);
  expect(report.system).toContainEqual({ scope: 'host', event: 'host.warn', level: 'warn', count: 1, crashes: 0 });
  expect(JSON.stringify(report)).not.toContain(secret);
  expect(JSON.stringify(report)).not.toContain('private.invalid');
  const parse = vi.spyOn(JSON, 'parse');
  expect(await reader.read(dir)).toEqual(report);
  expect(parse).not.toHaveBeenCalled();
  parse.mockRestore();
});

test('killed exit 15 and SIGTERM are neutral, not crash evidence', async (t) => {
  const dir = await fixture(t);
  await writeFile(
    join(dir, 'host.jsonl'),
    [
      { killed: true, exitCode: 15 },
      { status: 'killed', exitCode: 1 },
      { exitCode: 15 },
      { signal: 'SIGTERM' },
      { exitCode: 1 },
      { signal: 'SIGKILL' },
    ]
      .map((fields) => line({ scope: 'host', event: 'host.exit', level: 'warn', ...fields }))
      .join(''),
  );
  const report = await new LogEvidenceReader().read(dir);
  expect(report.system).toEqual([{ scope: 'host', event: 'host.exit', level: 'warn', count: 6, crashes: 2 }]);
});

test('bounded tails discard partial first/last lines and disclose truncation/corrupt coverage without raw text', async (t) => {
  const dir = await fixture(t);
  const file = join(dir, 'large.jsonl');
  await writeFile(file, 'secret-prefix'.repeat(20_000) + '\nnot-json\n' + line(operation()) + '{"incomplete":');
  const report = await new LogEvidenceReader().read(dir);
  expect(report.coverage).toMatchObject({
    scannedFiles: 1,
    inspectedBytes: 128 * 1024,
    truncatedFiles: 1,
    malformedLines: 1,
    partialLines: 2,
  });
  expect(report.operations.reduce((n, row) => n + row.finishes, 0)).toBe(1);
  expect(JSON.stringify(report)).not.toContain('secret-prefix');
});

test('keeps only unfinished starts unknown and deduplicates copied experience events', async (t) => {
  const dir = await fixture(t);
  const experience = line({ scope: 'plugin', plugin: 'sample', event: 'plugin:experience', data: {
    schemaVersion: 1, eventId: randomUUID(), pluginVersion: '1.0.0', event: 'click', action: 'activate',
  } });
  await writeFile(join(dir, 'one.jsonl'), line(operation({ event: 'operation.start', outcome: undefined, code: undefined })) + experience);
  await writeFile(join(dir, 'two.jsonl'), experience);
  const report = await new LogEvidenceReader().read(dir);
  expect(report.operations[0]).toMatchObject({ outcome: 'unknown', starts: 1, finishes: 0 });
  expect(report.experience[0]).toMatchObject({ pluginVersion: '1.0.0', records: 1 });
});

test('signature cache invalidates same-size edits with restored mtime, append and removal', async (t) => {
  const dir = await fixture(t);
  const file = join(dir, 'sample.jsonl');
  const reader = new LogEvidenceReader();
  const text = line({ scope: 'mem', event: 'sample', rss: 120, pid: 12 });
  await writeFile(file, text);
  expect((await reader.read(dir)).memory[0].peakRssMB).toBe(120);
  const info = await stat(file);
  await writeFile(file, text.replace('120', '320'));
  await utimes(file, info.atime, info.mtime);
  expect((await reader.read(dir)).memory[0].peakRssMB).toBe(320);
  await appendFile(file, line({ scope: 'mem', event: 'sample', rss: 640, pid: 12 }));
  expect((await reader.read(dir)).memory[0].peakRssMB).toBe(640);
  await rm(file);
  expect((await reader.read(dir)).memory).toEqual([]);
});

test('file/byte/group limits stay bounded, unreadable roots and symlinks do not escape to business logs', async (t) => {
  const dir = await fixture(t);
  const reader = new LogEvidenceReader();
  await Promise.all(
    Array.from({ length: 70 }, (_, i) =>
      writeFile(join(dir, `sample-${i}.jsonl`), 'x'.repeat(128 * 1024) + '\n' + line(operation())),
    ),
  );
  const report = await reader.read(dir);
  expect(report.coverage.candidateFiles).toBe(70);
  expect(report.coverage.inspectedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(report.coverage.scannedFiles).toBeLessThanOrEqual(64);
  expect(report.coverage.omittedFiles).toBeGreaterThan(0);
  expect((await reader.read(join(dir, 'missing'))).coverage.candidateFiles).toBe(0);
  await symlink(join(dir, 'sample-0.jsonl'), join(dir, 'link.jsonl'));
  expect((await reader.read(dir)).coverage.candidateFiles).toBe(70);
  await writeFile(join(dir, 'not-directory'), 'blocked');
  expect((await reader.read(join(dir, 'not-directory'))).coverage.unreadableFiles).toBe(1);
  const groups = join(dir, 'groups.jsonl');
  await writeFile(
    groups,
    Array.from({ length: 130 }, (_, i) => line(operation({ operation: `action-${i}` }))).join(''),
  );
  const grouped = await reader.read(dir);
  expect(grouped.operations.length).toBeLessThanOrEqual(100);
  expect(grouped.coverage.groupLimitReached).toBe(true);
});

test('review, list and Markdown report expose the same isolated log evidence within list budget', async (t) => {
  const dir = await fixture(t);
  const logs = join(dir, 'sample.jsonl');
  await writeFile(logs, line(operation()) + line({ scope: 'mem', event: 'sample', rss: 99, pid: 2 }));
  vi.stubEnv('MICA_LOG_DIR', dir);
  t.onTestFinished(async () => {
    vi.unstubAllEnvs();
  });
  const recorder = new HarnessRecorder(join(dir, 'review'));
  t.onTestFinished(() => recorder.dispose());
  const report = await recorder.review('/workspace/test');
  const path = await recorder.exportReport(undefined, report);
  const summary = summarizeList(report, path);
  expect(summary.logEvidence?.operations[0].finishes).toBe(1);
  expect(summary.logEvidence?.coverage.scannedFiles).toBe(1);
  expect(JSON.stringify(summary, null, 2).length).toBeLessThanOrEqual(LIST_MAX_CHARS);
  const markdown = await readFile(path, 'utf8');
  expect(markdown).toContain('## Log evidence');
  expect(markdown).toContain('peakRssMB');
  expect(markdown).toContain('99');
});

test('aborted reads reject before IO and on a warm cache hit without poisoning the cached projection', async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'sample.jsonl'), line({ scope: 'mem', event: 'sample', rss: 120, pid: 12 }));
  const reader = new LogEvidenceReader();
  const expected = await reader.read();
  const reason = new DOMException('cancelled cache read', 'AbortError');
  const controller = new AbortController();
  controller.abort(reason);
  await expect(reader.read(undefined, controller.signal)).rejects.toBe(reason);

  const active = new AbortController();
  const originalGet = ProjectionIndex.prototype.get;
  const get = vi.spyOn(ProjectionIndex.prototype, 'get').mockImplementationOnce(function (
    this: ProjectionIndex<unknown>,
    key,
    signature,
  ) {
    const value = originalGet.call(this, key, signature);
    expect(value).toBeDefined();
    active.abort(reason);
    return value;
  });
  t.onTestFinished(() => get.mockRestore());
  const parse = vi.spyOn(JSON, 'parse');
  t.onTestFinished(() => parse.mockRestore());
  await expect(reader.read(undefined, active.signal)).rejects.toBe(reason);
  expect(get).toHaveBeenCalledTimes(1);
  expect(await reader.read()).toEqual(expected);
  expect(parse).not.toHaveBeenCalled();
});

test('log scanning yields to cancellation mid-file and never caches a partial projection', async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'sample.jsonl'), line({ scope: 'mem', event: 'sample', rss: 120, pid: 12 }).repeat(400));
  const reader = new LogEvidenceReader();
  const controller = new AbortController();
  const reason = new DOMException('cancelled scanning', 'AbortError');
  const originalParse = JSON.parse;
  let parsed = 0;
  const parse = vi.spyOn(JSON, 'parse').mockImplementation((text) => {
    if (++parsed === 1) setImmediate(() => controller.abort(reason));
    return originalParse(text);
  });
  t.onTestFinished(() => parse.mockRestore());
  await expect(reader.read(undefined, controller.signal)).rejects.toBe(reason);
  expect(parsed).toBeGreaterThan(0);
  expect(parsed).toBeLessThan(400);
  parse.mockRestore();
  const report = await reader.read();
  expect(report.memory[0].samples).toBe(400);
  expect(report.coverage).toMatchObject({ scannedFiles: 1, malformedLines: 0, unreadableFiles: 0 });
});

test('AbortError thrown during log JSON projection is not swallowed as malformed data', async (t) => {
  const dir = await fixture(t);
  await writeFile(join(dir, 'sample.jsonl'), line(operation()));
  const reader = new LogEvidenceReader();
  const reason = new DOMException('JSON read cancelled', 'AbortError');
  const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
    throw reason;
  });
  t.onTestFinished(() => parse.mockRestore());
  await expect(reader.read()).rejects.toBe(reason);
  parse.mockRestore();
  expect((await reader.read()).operations[0].finishes).toBe(1);
});
