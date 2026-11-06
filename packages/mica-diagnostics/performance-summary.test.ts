import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearLogs, readPerformanceSummary, readPerformanceSummaryAsync } from './index.js';

const originalDir = process.env.MICA_LOG_DIR;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mica-perf-cache-'));
  process.env.MICA_LOG_DIR = dir;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalDir === undefined) delete process.env.MICA_LOG_DIR;
  else process.env.MICA_LOG_DIR = originalDir;
  rmSync(dir, { recursive: true, force: true });
});

const line = (at: number, scope: string, event: string, fields: Record<string, unknown> = {}) =>
  `${JSON.stringify({ at, level: 'info', scope, event, ...fields })}\n`;

describe('Performance summary cache', () => {
  it('isolates mutable output between concurrent readers while sharing the parse work', async () => {
    writeFileSync(join(dir, 'invoke-20261104.jsonl'), line(1, 'invoke', 'query', { ms: 10 }));
    const parse = vi.spyOn(JSON, 'parse');
    const [first, second] = await Promise.all([readPerformanceSummaryAsync(), readPerformanceSummaryAsync()]);
    expect(parse).toHaveBeenCalledTimes(1);
    first.totals.events = 999;
    first.events[0]!.event = 'mutated';
    first.buckets[0]!.count = 999;
    expect(second.totals.events).toBe(1);
    expect(second.events[0]!.event).toBe('query');
    expect(second.buckets[0]!.count).toBe(1);
    expect(readPerformanceSummary()).toEqual(second);
  });

  it('reuses unchanged projections in both APIs without parsing again or sharing mutable output', async () => {
    writeFileSync(join(dir, 'perf-20261104.jsonl'), line(1, 'perf', 'sample', { vis: 1, lag: 7 }));
    writeFileSync(join(dir, 'mem-20261104.jsonl'), line(2, 'mem', 'sample', { host: 'runtime', pid: 12, rss: 80 }));
    writeFileSync(join(dir, 'invoke-20261104.jsonl'), line(3, 'invoke', 'call', { ms: 10 }));
    const parse = vi.spyOn(JSON, 'parse');
    const initial = readPerformanceSummary();
    expect(parse).toHaveBeenCalledTimes(3);
    parse.mockClear();
    const again = await readPerformanceSummaryAsync();
    expect(again).toEqual(initial);
    expect(parse).not.toHaveBeenCalled();
    again.timeline[0]!.lag = 999;
    again.processes[0]!.lastRssMB = 999;
    again.buckets[0]!.count = 999;
    again.events[0]!.event = 'mutated';
    expect(readPerformanceSummary()).toEqual(initial);
    expect(parse).not.toHaveBeenCalled();
  });

  it('rebuilds only changed files on append, including completion of a partial last line', async () => {
    const path = join(dir, 'invoke-20261104.jsonl');
    const partial = line(2, 'invoke', 'new', { ms: 20 });
    writeFileSync(path, line(1, 'invoke', 'old', { ms: 10 }) + partial.slice(0, -5));
    writeFileSync(join(dir, 'mem-20261104.jsonl'), line(1, 'mem', 'sample', { pid: 12, rss: 80 }));
    expect((await readPerformanceSummaryAsync()).totals.events).toBe(2);
    appendFileSync(path, partial.slice(-5));
    const parse = vi.spyOn(JSON, 'parse');
    const summary = await readPerformanceSummaryAsync();
    expect(parse).toHaveBeenCalledTimes(2);
    expect(summary.totals.events).toBe(3);
    expect(summary.buckets.map((bucket) => bucket.event)).toEqual(['new', 'old']);
  });

  it('invalidates snapshots on same-size rewrites, replacement, truncation, removal and clear', async () => {
    const path = join(dir, 'invoke-20261104.jsonl');
    const old = line(1, 'invoke', 'old', { ms: 10 });
    const fresh = line(2, 'invoke', 'new', { ms: 20 });
    writeFileSync(path, old);
    await readPerformanceSummaryAsync();
    writeFileSync(path, fresh);
    utimesSync(path, 2, 2);
    expect(readPerformanceSummary().events[0]?.event).toBe('new');
    const replacement = join(dir, 'replacement');
    writeFileSync(replacement, old);
    renameSync(replacement, path);
    expect((await readPerformanceSummaryAsync()).events[0]?.event).toBe('old');
    truncateSync(path);
    expect(readPerformanceSummary().totals.events).toBe(0);
    writeFileSync(path, fresh);
    expect((await readPerformanceSummaryAsync()).totals.events).toBe(1);
    rmSync(path);
    expect(readPerformanceSummary().totals.events).toBe(0);
    writeFileSync(path, old);
    await readPerformanceSummaryAsync();
    expect(clearLogs().removed).toBe(1);
    expect((await readPerformanceSummaryAsync()).totals.events).toBe(0);
    writeFileSync(path, fresh);
    expect((await readPerformanceSummaryAsync()).events[0]?.event).toBe('new');
  });

  it('recalculates per-scope tail budgets after rotation and option changes', async () => {
    const oldPath = join(dir, 'invoke-20261104.jsonl');
    writeFileSync(oldPath, line(1, 'invoke', 'old', { ms: 10 }) + line(2, 'invoke', 'last', { ms: 20 }));
    utimesSync(oldPath, 1, 1);
    expect(readPerformanceSummary({ maxBytes: 100 }).events.map((item) => item.event)).toEqual(['last']);
    const newPath = join(dir, 'invoke-20261104-1.jsonl');
    writeFileSync(newPath, line(3, 'invoke', 'new', { ms: 30 }));
    const rotated = await readPerformanceSummaryAsync({ maxBytes: 100 });
    expect(rotated.events.map((item) => item.event)).toEqual(['new']);
    expect(readPerformanceSummary({ maxBytes: 1000 }).events.map((item) => item.event)).toEqual(['new', 'last', 'old']);
    expect((await readPerformanceSummaryAsync({ maxBytes: 1000, limit: 1 })).events.map((item) => item.event)).toEqual([
      'new',
    ]);
  });

  it('isolates cache state across log directories without creating missing directories', async () => {
    writeFileSync(join(dir, 'invoke-20261104.jsonl'), line(1, 'invoke', 'first'));
    await readPerformanceSummaryAsync();
    const other = join(dir, 'other');
    process.env.MICA_LOG_DIR = other;
    expect((await readPerformanceSummaryAsync()).totals.events).toBe(0);
    expect(() => readdirSync(other)).toThrow();
    process.env.MICA_LOG_DIR = dir;
    expect(readPerformanceSummary().events[0]?.event).toBe('first');
  });

  it('preserves chronological windows and process trends for out-of-order entries across files', async () => {
    const memory = (at: number, rss: number, fields: Record<string, unknown> = {}) =>
      line(at, 'mem', 'sample', { host: 'runtime', pid: 12, rss, ...fields });
    writeFileSync(
      join(dir, 'mem-20261104-1.jsonl'),
      memory(30, 120, { session: 'latest' }) + memory(10, 80, { session: 'first' }),
    );
    writeFileSync(join(dir, 'mem-20261104.jsonl'), memory(40, 100) + memory(20, 90, { session: 'middle' }));
    writeFileSync(
      join(dir, 'perf-20261104.jsonl'),
      [30, 10, 20, 40].map((at) => line(at, 'perf', 'sample', { vis: 1, lag: at })).join(''),
    );
    const result = await readPerformanceSummaryAsync({ timeline: 2, limit: 2 });
    expect(result.totals).toMatchObject({ spanMs: 30, memSamples: 4, samples: 4, peakRssMB: 120 });
    expect(result.memory.map((item) => item.at)).toEqual([30, 40]);
    expect(result.timeline.map((item) => item.at)).toEqual([30, 40]);
    expect(result.events.map((item) => item.at)).toEqual([40, 30]);
    expect(result.processes[0]).toMatchObject({
      samples: 4,
      firstRssMB: 80,
      lastRssMB: 100,
      growthMB: 20,
      peakRssMB: 120,
      session: 'latest',
    });
  });

  it('does not reuse an in-flight read after logs are cleared', async () => {
    writeFileSync(join(dir, 'invoke-20261104.jsonl'), line(1, 'invoke', 'old'));
    const beforeClear = readPerformanceSummaryAsync();
    clearLogs();
    const afterClear = readPerformanceSummaryAsync();
    await beforeClear;
    expect((await afterClear).totals.events).toBe(0);
  });

  it('keeps the requested directory when concurrent reads have to wait', async () => {
    const secondDir = join(dir, 'second');
    writeFileSync(join(dir, 'invoke-20261104.jsonl'), line(1, 'invoke', 'first'));
    const first = readPerformanceSummaryAsync();
    process.env.MICA_LOG_DIR = secondDir;
    const second = readPerformanceSummaryAsync();
    process.env.MICA_LOG_DIR = dir;
    expect((await first).events[0]?.event).toBe('first');
    expect((await second).dir).toBe(secondDir);
    expect((await second).totals.events).toBe(0);
  });

  it('preserves chronological tie order when rankings are limited', async () => {
    const oldPath = join(dir, 'invoke-20261104.jsonl');
    writeFileSync(oldPath, line(1, 'invoke', 'older', { ms: 10 }));
    utimesSync(oldPath, 1, 1);
    writeFileSync(join(dir, 'invoke-20261104-1.jsonl'), line(2, 'invoke', 'newer', { ms: 10 }));
    const result = await readPerformanceSummaryAsync({ buckets: 1 });
    expect(result.buckets.map((item) => item.event)).toEqual(['older']);
  });

  it('coalesces concurrent cold reads and lets other event-loop work run between chunks', async () => {
    const rows = 10_000;
    writeFileSync(
      join(dir, 'invoke-20261104.jsonl'),
      Array.from({ length: rows }, (_, at) => line(at + 1, 'invoke', 'call', { ms: 5, kind: 'call' })).join(''),
    );
    const parse = vi.spyOn(JSON, 'parse');
    let turns = 0;
    let stopped = false;
    const heartbeat = () => {
      if (!stopped) {
        turns += 1;
        setImmediate(heartbeat);
      }
    };
    setImmediate(heartbeat);
    const [first, second] = await Promise.all([readPerformanceSummaryAsync(), readPerformanceSummaryAsync()]);
    stopped = true;
    expect(first).toEqual(second);
    expect(first.totals.events).toBe(rows);
    expect(parse).toHaveBeenCalledTimes(rows);
    expect(turns).toBeGreaterThan(2);
  });

  it('keeps compact projections and counts all files when cache capacity is exceeded', async () => {
    for (let n = 0; n < 270; n += 1) {
      writeFileSync(
        join(dir, `scope${n}-20261104.jsonl`),
        line(n + 1, `scope${n}`, 'error', { level: 'error', error: { message: 'failure', payload: 'x'.repeat(8000) } }),
      );
    }
    const parse = vi.spyOn(JSON, 'parse');
    for (let n = 0; n < 2; n += 1) {
      parse.mockClear();
      const result = await readPerformanceSummaryAsync({ limit: 2 });
      expect(result.totals.events).toBe(270);
      if (n === 1) expect(parse).not.toHaveBeenCalled();
      expect(result.events).toHaveLength(2);
      expect(result.events[0]?.error).toBe('failure');
      expect(JSON.stringify(result).length).toBeLessThan(6000);
    }
  });
});
