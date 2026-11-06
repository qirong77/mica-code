import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectMemory,
  flushLogs,
  logger,
  readPerformanceSummary,
  slowReport,
  startMemorySampler,
} from './index.js';

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

  /**
   * 调用方归因：同一个通道会被十几个调用方打（5 个缓存中的 ChatView、多个窗口…），
   * 只按通道名聚合回答不了「这 600 次是谁发的」。meta 只进事件行，不进聚合键。
   */
  it('timedResult 的调用方现场只跟在事件行上，不改变聚合口径', async () => {
    const invoke = logger('invoke');
    // 阈值 0 让它落成 slow：`kind: 'call'` 的常态调用按设计不进事件流（只看聚合表）。
    await invoke.timedResult(
      'plugin-panel-view',
      async () => ({ ok: true }),
      0,
      {
        plugin: 'cleanmymac',
        sid: '20261106T033922Z-pcu20t',
        hidden: true,
      },
    );
    flushLogs();
    const summary = readPerformanceSummary();
    const event = summary.events.find((entry) => entry.event === 'plugin-panel-view');
    expect(event).toMatchObject({ plugin: 'cleanmymac', hidden: true });
    // 聚合表仍然只按 `scope:event` 一行，不被高基数键撑开。
    expect(summary.buckets.filter((bucket) => bucket.event === 'plugin-panel-view')).toHaveLength(1);
  });
});

describe('collectMemory', () => {
  /**
   * Bun（JSC）的 heapUsed/heapTotal/external 与实际占用对不上：实测出现过
   * `heapUsed 524MB > heapTotal 374MB`、日志里 `heap 5014MB / heapT 161MB`、
   * `rss 95MB / ext 430MB`。写进日志会让「谁在涨」的判断整体失真，所以 Bun 下不写这几项。
   */
  it('Bun 下不写不可信的 heap 字段，只留 RSS', () => {
    const original = process.versions.bun;
    Object.defineProperty(process.versions, 'bun', { value: '1.3.14', configurable: true });
    try {
      const memory = collectMemory({ host: 'app-server' });
      expect(memory).toMatchObject({ host: 'app-server', runtime: 'bun', heapReliable: false });
      expect(memory).not.toHaveProperty('heap');
      expect(memory).not.toHaveProperty('heapT');
      expect(memory).not.toHaveProperty('ext');
      expect(typeof memory.rss).toBe('number');
    } finally {
      Object.defineProperty(process.versions, 'bun', { value: original, configurable: true });
    }
  });

  it('Node/V8 下照常写 heap / external', () => {
    const original = process.versions.bun;
    Object.defineProperty(process.versions, 'bun', { value: undefined, configurable: true });
    try {
      const memory = collectMemory();
      expect(memory).toMatchObject({ runtime: 'node', engine: 'v8' });
      expect(typeof memory.heap).toBe('number');
      expect(typeof memory.heapT).toBe('number');
      expect(memory.heapReliable).toBeUndefined();
    } finally {
      Object.defineProperty(process.versions, 'bun', { value: original, configurable: true });
    }
  });

  /**
   * 一个回合把宿主顶到 2GB 再还回去，30 秒一条的采样只会留下两三个点，事后看不出
   * 「那一刻在跑什么」。越阈值时单独记一条 warn，把 describe 的现场固定下来。
   */
  it('RSS 越过阈值时补一条 spike，并在高位期间不重复刷', async () => {
    vi.useFakeTimers();
    try {
      const stop = startMemorySampler({
        host: 'app-server',
        intervalMs: 5_000,
        spikeRssMB: 1,
        describe: () => ({ session: '20261106T033922Z-pcu20t', tools: 41 }),
      });
      vi.advanceTimersByTime(5_000);
      vi.advanceTimersByTime(5_000);
      stop();
      flushLogs();
      const summary = readPerformanceSummary();
      const spikes = summary.events.filter((entry) => entry.event === 'spike');
      expect(spikes).toHaveLength(1);
      expect(spikes[0]).toMatchObject({ level: 'warn', scope: 'mem' });
    } finally {
      vi.useRealTimers();
    }
  });
});
