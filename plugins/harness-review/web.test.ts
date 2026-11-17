import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi, type TestContext } from 'vitest';
import type { PluginWebContext } from '@packages/mica-plugin/PluginWeb.js';
import type { ConsoleSnapshot } from './console-types.js';
import { HarnessRecorder, type RunSummary } from './engine.js';
import createWeb from './web.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'mica-harness-web-'));
  const context: PluginWebContext = {
    pluginId: 'harness-review',
    pluginVersion: '0.1.0',
    paths: { config: join(root, 'config'), data: join(root, 'data') },
    settings: { get: () => ({ enabled: 'true', captureContent: 'true' }) },
    catalog: [],
  };
  vi.stubEnv('MICA_LOG_DIR', join(root, 'logs'));
  t.onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });
  return { root, context };
}

async function fileTree(directory: string): Promise<Record<string, { bytes: string; modified: number; mode: number }>> {
  const files: Record<string, { bytes: string; modified: number; mode: number }> = {};
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) await visit(name);
      else {
        const info = await stat(name);
        files[name] = {
          bytes: createHash('sha256')
            .update(await readFile(name))
            .digest('hex'),
          modified: info.mtimeMs,
          mode: info.mode,
        };
      }
    }
  }
  await visit(directory);
  return files;
}

test('web exposes only raw snapshot JSON and refuses every query parameter, including arbitrary path selectors', async (t) => {
  const { root, context } = await fixture(t);
  const handler = createWeb(context);
  t.onTestFinished(() => handler.dispose?.());
  assert.deepEqual(Object.keys(handler.queries), ['snapshot']);
  for (const key of ['root', 'cwd', 'run', 'file', 'refresh', 'unknown']) {
    assert.throws(
      () => handler.queries.snapshot({ [key]: '/private/arbitrary' }, { signal: new AbortController().signal }),
      /does not accept query parameters/,
    );
  }
  const result = (await handler.queries.snapshot({}, { signal: new AbortController().signal })) as ConsoleSnapshot;
  assert.equal(result.version, 1);
  assert.equal(result.counts.runs, 0);
  assert.ok(Array.isArray(result.runs));
  assert.equal((result as unknown as { reportPath?: string }).reportPath, undefined);
  assert.deepEqual(await readdir(root), []);
});

test('read-only GET and dispose leave every file unchanged, including zombie runs and an existing plugin-event lock', async (t) => {
  const { root, context } = await fixture(t);
  const recorder = new HarnessRecorder(context.paths.data);
  const owner = {};
  recorder.observe(
    {
      type: 'run:start',
      owner,
      runId: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      input: 'INPUT-CANARY',
      config: { providerId: 'test', protocol: 'openai', model: 'model', effort: 'medium', role: 'main' },
    },
    { id: 'session', title: 'Safe title', cwd: '/workspace' },
    { captureContent: true, maxEventChars: 4000, maxEventsPerRun: 2000 },
  );
  await recorder.flush();
  // Do not dispose the writer: the on-disk running record intentionally models
  // a dead capturing host, and the web service must never reclaim it.
  const id = (await readdir(join(context.paths.data, 'runs')))[0];
  const file = join(context.paths.data, 'runs', id, 'summary.json');
  const zombie = JSON.parse(await readFile(file, 'utf8')) as RunSummary;
  zombie.hostPid = 999_999_999;
  await writeFile(file, JSON.stringify(zombie));
  await mkdir(context.paths.config, { recursive: true });
  await writeFile(join(context.paths.data, 'plugin-events.lock'), 'existing lock must not be reclaimed');
  await writeFile(
    join(context.paths.data, 'plugin-events.jsonl'),
    `${JSON.stringify({ at: '2026-01-01T00:00:00.000Z', pluginId: 'sample', taskId: 'poll', failures: 3, error: 'RAW-ERROR-CANARY' })}\n`,
  );
  const before = await fileTree(root);
  const handler = createWeb(context);
  const value = (await handler.queries.snapshot({}, { signal: new AbortController().signal })) as ConsoleSnapshot;
  await handler.dispose?.();
  assert.deepEqual(await fileTree(root), before);
  assert.equal(value.runs[0].outcome, 'running');
  assert.equal(value.pluginFailures[0].count, 3);
  assert.equal(value.pluginFailures[0].lastError, '');
  assert.ok(!JSON.stringify(value).includes('INPUT-CANARY'));
  assert.ok(!JSON.stringify(value).includes('RAW-ERROR-CANARY'));
  assert.equal(JSON.parse(await readFile(file, 'utf8')).reclaimedAt, undefined);
});

test('already cancelled HTTP queries do not start scans or write files', async (t) => {
  const { root, context } = await fixture(t);
  const handler = createWeb(context);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    Promise.resolve().then(() => handler.queries.snapshot({}, { signal: controller.signal })),
    { name: 'AbortError' },
  );
  await handler.dispose?.();
  assert.deepEqual(await readdir(root), []);
});
