import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flushLogs, logger, readPerformanceSummary, slowReport } from './index.js';

const originalDir = process.env.MICA_LOG_DIR;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mica-perf-summary-'));
  process.env.MICA_LOG_DIR = dir;
});

afterEach(() => {
  flushLogs();
  if (originalDir === undefined) delete process.env.MICA_LOG_DIR;
  else process.env.MICA_LOG_DIR = originalDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('Performance summary', () => {
  it('reads each scope independently from file tails, including older shards', () => {
    const at = Date.now();
    const line = (scope: string, event: string, fields: Record<string, unknown> = {}) =>
      `${JSON.stringify({ at, level: 'info', scope, event, ...fields })}\n`;
    writeFileSync(
      join(dir, 'perf-20261104.jsonl'),
      `${'x'.repeat(1300)}\n${line('perf', 'sample', { vis: 1, lag: 7 })}`,
    );
    writeFileSync(
      join(dir, 'mem-20261104.jsonl'),
      `${'x'.repeat(1300)}\n${line('mem', 'sample', { host: 'runtime', pid: 12, rss: 80 })}`,
    );
    writeFileSync(join(dir, 'invoke-20261104.jsonl'), `${'x'.repeat(1300)}\n${line('invoke', 'older', { ms: 11 })}`);
    writeFileSync(join(dir, 'invoke-20261104-1.jsonl'), line('invoke', 'newer', { ms: 15 }));

    const summary = readPerformanceSummary({ maxBytes: 180 });
    expect(summary.totals.samples).toBe(1);
    expect(summary.totals.memSamples).toBe(1);
    expect(summary.processes[0]?.lastRssMB).toBe(80);
    expect(summary.buckets.map((bucket) => bucket.event)).toEqual(expect.arrayContaining(['older', 'newer']));
  });

  it('uses the sample acquisition time rather than the batch write time', () => {
    const at = Date.now() - 15_000;
    logger('perf').info('sample', { at, vis: 1, lag: 5 });
    flushLogs();

    expect(readPerformanceSummary().timeline[0]?.at).toBe(at);
  });

  it('counts a slow failed result only once, preserving slow and failure details', async () => {
    await logger('invoke').timedResult('failed-result', async () => ({ ok: false, error: 'timeout' }), 0);
    await expect(
      logger('invoke').timedResult(
        'thrown',
        async () => {
          throw new Error('broken');
        },
        0,
      ),
    ).rejects.toThrow('broken');
    flushLogs();

    const summary = readPerformanceSummary();
    for (const event of ['failed-result', 'thrown']) {
      expect(summary.buckets.find((bucket) => bucket.event === event)).toMatchObject({ count: 1, fails: 1, slow: 1 });
      expect(summary.events.filter((entry) => entry.event === event)).toHaveLength(1);
      const lines = readdirSync(dir)
        .filter((name) => name.startsWith('invoke-'))
        .flatMap((name) =>
          readFileSync(join(dir, name), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
        );
      expect(lines.filter((entry) => entry.event === event)).toHaveLength(1);
    }
    expect(summary.events.find((entry) => entry.event === 'failed-result')?.error).toBe('timeout');
    expect(summary.events.find((entry) => entry.event === 'thrown')?.error).toBe('broken');
  });

  it('counts thrown timed calls once, whether slow or fast', async () => {
    for (const [event, limit] of [
      ['timed-slow', 0],
      ['timed-fast', Infinity],
    ] as const) {
      await expect(
        logger('invoke').timed(
          event,
          async () => {
            throw new Error(event);
          },
          limit,
        ),
      ).rejects.toThrow(event);
    }
    flushLogs();
    const summary = readPerformanceSummary();
    for (const [event, slow] of [
      ['timed-slow', 1],
      ['timed-fast', 0],
    ] as const) {
      expect(summary.buckets.find((bucket) => bucket.event === event)).toMatchObject({ count: 1, fails: 1, slow });
      expect(summary.events.filter((entry) => entry.event === event)).toHaveLength(1);
      expect(summary.events.find((entry) => entry.event === event)).toMatchObject({ level: 'error', error: event });
      expect(slowReport().find((item) => item.key === `invoke:${event}`)).toMatchObject({ count: 1, fails: 1, slow });
    }
  });
});
