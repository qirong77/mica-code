import { cp, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { AgentObservationEvent } from '@packages/mica-plugin/index.js';

const io = vi.hoisted(() => ({ traces: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    readFile: (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]).endsWith('/events.jsonl')) io.traces++;
      return fs.readFile(...args);
    },
  };
});
import { HarnessRecorder } from './engine.js';
import { ProjectionIndex } from './derived-index.js';

async function fixture(t: { onTestFinished: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'mica-harness-derived-'));
  const root = join(directory, 'original');
  const recorder = new HarnessRecorder(root);
  const owner = {};
  const emit = (event: object) =>
    recorder.observe(
      { owner, runId: 1, timestamp: '2026-06-03T12:00:00Z', ...event } as AgentObservationEvent,
      { id: 'test', title: 'Test', cwd: '/workspace/test' },
      { captureContent: true, maxEventChars: 4000, maxEventsPerRun: 100 },
    );
  emit({
    type: 'run:start',
    config: { providerId: 'test', protocol: 'test', model: 'test', effort: '', role: '' },
    input: 'private-input',
  });
  emit({ type: 'tool:call', name: 'read_file', id: 'a', args: '{"path":"private-path"}' });
  emit({ type: 'tool:result', name: 'read_file', id: 'a', result: 'Error: EACCES private-error' });
  emit({ type: 'run:finish', outcome: 'completed', elapsedMs: 1 });
  t.onTestFinished(async () => {
    await recorder.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  return { recorder, root, directory };
}

test('bounded projection index clones, invalidates, evicts by bytes/LRU and retains only live keys', () => {
  const index = new ProjectionIndex<{ n: number }>(2, 100);
  index.set('a', 's', { n: 1 });
  index.set('b', 's', { n: 2 });
  index.get('a', 's')!.n = 9;
  index.set('c', 's', { n: 3 });
  expect(index.get('b', 's')).toBeUndefined();
  expect(index.get('a', 's')).toEqual({ n: 1 });
  expect(index.get('a', 'changed')).toBeUndefined();
  index.retain(new Set());
  expect(index.get('c', 's')).toBeUndefined();
  const tiny = new ProjectionIndex<string>(3, 12);
  tiny.set('a', 's', '12345678901234567890');
  expect(tiny.get('a', 's')).toBeUndefined();
});

test('review caches derived trace metadata, re-dates windows, and invalidates same-size edits, append and deletion', async (t) => {
  const { recorder } = await fixture(t);
  vi.useFakeTimers({ toFake: ['Date'] });
  t.onTestFinished(async () => {
    vi.useRealTimers();
  });
  vi.setSystemTime('2026-06-03T13:00:00Z');
  io.traces = 0;
  const first = await recorder.review();
  expect(io.traces).toBe(1);
  expect(first.findings[0].recentOccurrences).toBe(1);
  first.runs[0].findings[0].title = 'caller-mutation';
  vi.setSystemTime('2026-06-06T13:00:00Z');
  const second = await recorder.review();
  expect(io.traces).toBe(1);
  expect(second.findings[0].title).not.toBe('caller-mutation');
  expect(second.findings[0].recentOccurrences).toBe(0);
  const file = second.runs[0].traceFile;
  const info = await stat(file);
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace('EACCES', 'ENOENT'));
  await utimes(file, info.atime, info.mtime);
  io.traces = 0;
  expect((await recorder.review()).findings[0].title).toContain('not-found');
  expect(io.traces).toBe(1);
  await writeFile(file, text + 'broken\n');
  expect((await recorder.review()).toolHealthCoverage.excludedRuns).toBe(1);
  await rm(file);
  const missing = await recorder.review();
  expect(missing.findings[0].evidence[0].available).toBe(false);
  expect(missing.warnings.join(' ')).toContain('missing or unreadable trace');
});

test('copied or moved roots never read still-existing old traces; evidence and rebuild use current root', async (t) => {
  const { recorder, directory, root } = await fixture(t);
  const initial = await recorder.review();
  const copied = join(directory, 'copied');
  await cp(root, copied, { recursive: true });
  const copy = new HarnessRecorder(copied);
  t.onTestFinished(() => copy.dispose());
  const target = join(copied, 'runs', initial.runs[0].id, 'events.jsonl');
  const originalText = await readFile(initial.runs[0].traceFile, 'utf8');
  await writeFile(target, originalText.replace('EACCES', 'ENOENT'));
  const report = await copy.review();
  expect(report.findings[0].title).toContain('not-found');
  expect(report.findings[0].evidence[0].traceFile).toBe(target);
  expect(report.runs[0].traceFile).toBe(target);
  expect((await copy.rebuild()).rebuilt).toBe(1);
  const saved = JSON.parse(await readFile(join(copied, 'runs', initial.runs[0].id, 'summary.json'), 'utf8'));
  expect(saved.traceFile).toBe(target);
  expect(saved.findings[0].evidence[0].traceFile).toBe(target);
  await rm(target);
  expect((await copy.review()).findings[0].evidence[0].available).toBe(false);
  expect((await copy.rebuild()).skippedUnreadable).toBe(1);
  // Renaming the only remaining root does not require a readable historical absolute path.
  const moved = join(directory, 'moved');
  await recorder.dispose();
  await rename(root, moved);
  const move = new HarnessRecorder(moved);
  t.onTestFinished(() => move.dispose());
  expect((await move.review()).findings[0].evidence[0]).toMatchObject({
    available: true,
    traceFile: join(moved, 'runs', initial.runs[0].id, 'events.jsonl'),
  });
});
