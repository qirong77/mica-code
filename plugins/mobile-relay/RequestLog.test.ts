import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequestLogger } from './agent/request-log.mjs';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, readdir: vi.fn(original.readdir), stat: vi.fn(original.stat), open: vi.fn(original.open) };
});

const FILE_BYTES = 2 * 1024 * 1024;
const TOTAL_BYTES = 32 * 1024 * 1024;
const entry = { endpoint: '/api/poll', outcome: 'ok', status: 200, requestBytes: 100, responseBytes: 200 };

describe('mobile-relay request log', () => {
  let dir: string;
  let loggers: Array<ReturnType<typeof createRequestLogger>>;

  function logger() {
    const result = createRequestLogger({ dir });
    loggers.push(result);
    return result;
  }

  function files() {
    return readdirSync(dir)
      .filter((name) => /^relay-requests-.*\.jsonl$/.test(name))
      .sort();
  }

  function rows() {
    return files().flatMap((name) =>
      readFileSync(join(dir, name), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mica-relay-requests-'));
    loggers = [];
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
  });

  afterEach(async () => {
    for (const log of loggers) await log.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('projects only metadata and never serializes secrets, bodies, errors or arbitrary fields', async () => {
    const log = logger();
    log.record({
      ...entry,
      ts: 'untrusted timestamp',
      durationMs: 4.9,
      resultCount: 2,
      eventCount: 3,
      commandCount: 4,
      url: 'https://secret.example/?token=super-secret',
      token: 'super-secret',
      payload: { text: 'private conversation', command: 'private terminal input' },
      error: new Error('private error text'),
      channels: {
        'git:status': 2,
        'terminal:write': 1,
        __attachment: 1,
        'bad\nchannel': 3,
        'https://secret.example': 1,
        ['x'.repeat(81)]: 1,
      },
      toJSON() {
        throw new Error('must not serialize the caller');
      },
    });
    await log.flush();
    expect(rows()).toEqual([
      {
        ts: '2026-11-10T12:00:00.000Z',
        ...entry,
        durationMs: 4,
        resultCount: 2,
        eventCount: 3,
        commandCount: 4,
        channels: { 'git:status': 2, 'terminal:write': 1, __attachment: 1 },
      },
    ]);
    expect(statSync(join(dir, files()[0]!)).mode & 0o777).toBe(0o600);
  });

  it('rejects endpoints, outcomes and non-numeric metadata instead of coercing strings', async () => {
    const log = logger();
    log.record({ ...entry, endpoint: '/api/poll?token=secret' });
    log.record({ ...entry, outcome: 'private error text' });
    log.record({
      ...entry,
      status: 'secret',
      durationMs: Infinity,
      resultCount: -1,
      eventCount: 'secret',
      channels: { valid: 'secret', bad: NaN },
    });
    await log.flush();
    expect(rows()).toEqual([
      {
        ts: '2026-11-10T12:00:00.000Z',
        endpoint: '/api/poll',
        outcome: 'ok',
        requestBytes: 100,
        responseBytes: 200,
        channels: {},
      },
    ]);
  });

  it('defers writes for two seconds and batches queued records without per-record directory scans', async () => {
    const log = logger();
    for (let i = 0; i < 20; i++) log.record(entry);
    expect(files()).toEqual([]);
    expect(fs.open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(files()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await log.flush();
    expect(rows()).toHaveLength(20);
    log.record(entry);
    await log.flush();
    expect(rows()).toHaveLength(21);
    expect(fs.readdir).toHaveBeenCalledTimes(1);
    expect(fs.stat).not.toHaveBeenCalled();
    expect(fs.open).toHaveBeenCalledTimes(1);
  });

  it('bounds channel cardinality and pending queue entries', async () => {
    const log = logger();
    for (let i = 0; i < 3_000; i++) log.record(entry);
    await log.flush();
    expect(rows()).toHaveLength(1_024);
    const channels = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`channel-${i}`, 1]));
    log.record({ ...entry, channels });
    await log.flush();
    expect(Object.keys(rows().at(-1)!.channels)).toHaveLength(32);
  });

  it('does not strand a record following an empty flush or concurrent flush calls', async () => {
    const log = logger();
    const empty = log.flush();
    log.record(entry);
    await Promise.all([empty, log.flush(), log.flush()]);
    log.record(entry);
    await log.close();
    expect(rows()).toHaveLength(2);
  });

  it('bounds queued bytes as well as entry count', async () => {
    const log = logger();
    const channels = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`channel-${i}-${'x'.repeat(60)}`, 1]));
    for (let i = 0; i < 1_024; i++) log.record({ ...entry, channels });
    await log.flush();
    const size = files().reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
    expect(size).toBeLessThanOrEqual(256 * 1024);
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().length).toBeLessThan(1_024);
  });

  it('rotates before exceeding two MiB and continues an existing private shard', async () => {
    const first = join(dir, 'relay-requests-20261110.jsonl');
    writeFileSync(first, '');
    truncateSync(first, FILE_BYTES - 1);
    const log = logger();
    log.record(entry);
    await log.flush();
    expect(files()).toEqual(['relay-requests-20261110-1.jsonl', 'relay-requests-20261110.jsonl']);
    expect(statSync(first).size).toBe(FILE_BYTES - 1);
    const second = join(dir, 'relay-requests-20261110-1.jsonl');
    expect(statSync(second).size).toBeLessThan(FILE_BYTES);
    await log.close();
    const next = logger();
    next.record(entry);
    await next.close();
    expect(readFileSync(second, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(statSync(second).mode & 0o777).toBe(0o600);
  });

  it('keeps only seven calendar days and at most 32 MiB without touching unrelated files', async () => {
    writeFileSync(join(dir, 'relay-requests-20261103.jsonl'), 'expired');
    writeFileSync(join(dir, 'plugin-mobile-relay-20261103.jsonl'), 'unrelated');
    for (let index = 0; index < 18; index++) {
      const path = join(dir, `relay-requests-20261104${index ? `-${index}` : ''}.jsonl`);
      writeFileSync(path, '');
      truncateSync(path, FILE_BYTES);
    }
    const log = logger();
    log.record(entry);
    await log.flush();
    expect(files()).not.toContain('relay-requests-20261103.jsonl');
    expect(files()).not.toContain('relay-requests-20261104.jsonl');
    expect(readFileSync(join(dir, 'plugin-mobile-relay-20261103.jsonl'), 'utf8')).toBe('unrelated');
    expect(files().reduce((sum, name) => sum + statSync(join(dir, name)).size, 0)).toBeLessThanOrEqual(TOTAL_BYTES);
    const scans = vi.mocked(fs.readdir).mock.calls.length;
    log.record(entry);
    await log.flush();
    expect(fs.readdir).toHaveBeenCalledTimes(scans);
    await vi.advanceTimersByTimeAsync(60_000);
    log.record(entry);
    await log.flush();
    expect(fs.readdir).toHaveBeenCalledTimes(scans + 1);
  });

  it('uses a new date at midnight and flushes once on close', async () => {
    const log = logger();
    log.record(entry);
    await log.flush();
    vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
    log.record({ ...entry, endpoint: '/api/push', outcome: 'network-error', status: 0 });
    await Promise.all([log.close(), log.close()]);
    log.record(entry);
    await log.flush();
    expect(files()).toEqual(['relay-requests-20261110.jsonl', 'relay-requests-20261111.jsonl']);
    expect(rows()).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops excess writes at the hard total limit without rescanning the directory', async () => {
    for (let index = 0; index < 15; index++) {
      const path = join(dir, `relay-requests-20261110${index ? `-${index}` : ''}.jsonl`);
      writeFileSync(path, '');
      truncateSync(path, FILE_BYTES);
    }
    const log = logger();
    const channels = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`channel-${i}-${'x'.repeat(60)}`, 1]));
    for (let batch = 0; batch < 12; batch++) {
      for (let i = 0; i < 1_024; i++) log.record({ ...entry, channels });
      await log.flush();
    }
    expect(files().reduce((sum, name) => sum + statSync(join(dir, name)).size, 0)).toBeLessThanOrEqual(TOTAL_BYTES);
    expect(files()).toHaveLength(16);
    expect(fs.readdir).toHaveBeenCalledTimes(1);
  });

  it('swallows write failures, retries no faster than once a minute and can recover', async () => {
    const blockedDir = join(dir, 'not-a-directory');
    writeFileSync(blockedDir, 'blocked');
    const log = createRequestLogger({ dir: blockedDir });
    loggers.push(log);
    log.record(entry);
    await expect(log.flush()).resolves.toBeUndefined();
    rmSync(blockedDir);
    log.record(entry);
    await log.flush();
    expect(readdirSync(dir)).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    log.record(entry);
    await log.close();
    expect(readdirSync(blockedDir)).toEqual(['relay-requests-20261110.jsonl']);
  });
});
