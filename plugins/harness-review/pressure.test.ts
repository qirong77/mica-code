import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentObservationEvent } from '@packages/mica-plugin/index.js';

const io = vi.hoisted(() => ({ summaries: 0, append: 0, block: null as Promise<void> | null }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    appendFile: async (...args: Parameters<typeof fs.appendFile>) => {
      io.append++;
      if (io.block) await io.block;
      return fs.appendFile(...args);
    },
    rename: (...args: Parameters<typeof fs.rename>) => {
      io.summaries++;
      return fs.rename(...args);
    },
  };
});
import { HarnessRecorder } from './engine.js';

const directories: string[] = [];
afterEach(async () => {
  io.block = null;
  io.summaries = io.append = 0;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function fixture(maxEventsPerRun = 100_000) {
  const root = await mkdtemp(join(tmpdir(), 'mica-harness-pressure-'));
  directories.push(root);
  const recorder = new HarnessRecorder(root);
  const owner = {};
  const emit = (event: object) =>
    recorder.observe(
      { owner, runId: 1, timestamp: '2026-06-01T10:00:00.000Z', ...event } as AgentObservationEvent,
      null,
      { captureContent: true, maxEventChars: 20_000, maxEventsPerRun },
    );
  emit({ type: 'run:start', config: {}, input: 'pressure' });
  return { recorder, emit };
}

it('checkpoints summaries instead of replacing them for every paced event', async () => {
  const { recorder, emit } = await fixture();
  try {
    for (let index = 0; index < 100; index++) {
      emit({ type: 'request:start', messageCount: index });
      // Allow each trace write to drain without an explicit summary checkpoint.
      await (recorder as unknown as { tail: Promise<void> }).tail;
    }
    emit({ type: 'run:finish', outcome: 'completed', elapsedMs: 1 });
    await recorder.flush();
    console.log(JSON.stringify({ sample: '102 paced events', append: io.append, summaries: io.summaries }));
    const report = await recorder.review();
    expect(report.runs[0]).toMatchObject({
      requestCount: 100,
      eventCount: 102,
      droppedEvents: 0,
      outcome: 'completed',
    });
    expect(io.summaries).toBeLessThanOrEqual(6);
  } finally {
    await recorder.dispose();
  }
});

it('bounds trace bytes under stalled IO while preserving counters and terminal state', async () => {
  const { recorder, emit } = await fixture();
  let release!: () => void;
  io.block = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let index = 0; index < 1500; index++)
      emit({ type: 'tool:result', name: 'read_file', result: 'bounded payload '.repeat(2000) });
    emit({ type: 'run:finish', outcome: 'aborted', elapsedMs: 10 });
    expect((recorder as unknown as { pendingTraceBytes: number }).pendingTraceBytes).toBeLessThanOrEqual(
      4 * 1024 * 1024,
    );
    release();
    io.block = null;
    const report = await recorder.review();
    expect(report.runs[0]).toMatchObject({ eventCount: 1502, outcome: 'aborted' });
    expect(report.runs[0].droppedEvents).toBeGreaterThan(0);
    const lines = (await readFile(report.runs[0].traceFile, 'utf8')).trim().split('\n');
    expect(lines.length + report.runs[0].droppedEvents).toBe(1502);
    expect(report.warnings.some((warning) => /invalid|non-consecutive|does not match/i.test(warning))).toBe(false);
  } finally {
    release();
    await recorder.dispose();
  }
});

it('keeps full counters after the trace limit without repeatedly preparing discarded payloads', async () => {
  const { recorder, emit } = await fixture(1);
  try {
    const result = 'ordinary multiline output\n'.repeat(10_000);
    const started = performance.now();
    for (let index = 0; index < 200; index++) emit({ type: 'tool:result', name: 'read_file', result });
    console.log(
      JSON.stringify({ sample: '200 discarded 260KB results', observeMs: +(performance.now() - started).toFixed(2) }),
    );
    emit({ type: 'run:finish', outcome: 'completed', elapsedMs: 1 });
    const report = await recorder.review();
    expect(report.runs[0]).toMatchObject({ eventCount: 202, droppedEvents: 201, outcome: 'completed' });
  } finally {
    await recorder.dispose();
  }
});
