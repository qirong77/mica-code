import { describe, expect, it } from 'vitest';
import { emptySnapshot, normalizeSnapshot, readWithRetry } from './snapshot.js';

/**
 * 首屏读数据这件事两半：坏数据要退回空态而不是崩，读到空要短退一次而不是立刻画空。
 */

describe('readWithRetry', () => {
  it('returns the first non-empty value without waiting', async () => {
    const waits: number[] = [];
    let calls = 0;
    const value = await readWithRetry(
      async () => {
        calls += 1;
        return { ready: true };
      },
      {
        attempts: 3,
        delayMs: 250,
        wait: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(value).toEqual({ ready: true });
    expect(calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('retries while the host has nothing yet, then takes what shows up', async () => {
    let calls = 0;
    const value = await readWithRetry(
      async () => {
        calls += 1;
        return calls < 3 ? null : { ready: true };
      },
      { attempts: 3, delayMs: 250, wait: async () => {} },
    );
    expect(value).toEqual({ ready: true });
    expect(calls).toBe(3);
  });

  it('gives up after the budget so a truly empty install still shows its empty state', async () => {
    let calls = 0;
    const waits: number[] = [];
    const value = await readWithRetry(
      async () => {
        calls += 1;
        return null;
      },
      {
        attempts: 3,
        delayMs: 250,
        wait: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(value).toBeNull();
    // 试 3 次 = 读 3 次、等 2 次（最后一次读到空就不再等）
    expect(calls).toBe(3);
    expect(waits).toHaveLength(2);
  });

  it('treats undefined like null', async () => {
    let calls = 0;
    const value = await readWithRetry(
      async () => {
        calls += 1;
        return calls < 2 ? undefined : 'later';
      },
      { attempts: 2, delayMs: 1, wait: async () => {} },
    );
    expect(value).toBe('later');
    expect(calls).toBe(2);
  });
});

describe('normalizeSnapshot', () => {
  it('falls back to the empty snapshot for a value it cannot read', () => {
    expect(normalizeSnapshot(null)).toEqual(emptySnapshot());
    expect(normalizeSnapshot('not-a-record')).toEqual(emptySnapshot());
  });

  it('keeps the groups it can read even when some fields are wrong', () => {
    const snapshot = normalizeSnapshot({
      updatedAtMs: 123,
      updatedAt: '11-01 09:00',
      coverage: '扫了 2 个群 · 1 个有排期',
      groups: [
        {
          id: 'g1',
          name: '群一',
          author: '张三',
          announcedAt: 456,
          stages: [{ key: 'dev', label: '开发', start: '2026-11-01', end: '2026-11-03', days: ['2026-11-01'] }],
        },
        // 没有阶段的组不该画成一条空行
        { id: 'g2', name: '群二', stages: [] },
        // 认不出的条目直接丢掉
        { name: '没有 id' },
        { id: 'bad', name: '坏日期', stages: [{ key: 'dev', start: '2026-02-30', end: '2026-03-02' }] },
      ],
    });
    expect(snapshot.groups).toHaveLength(1);
    expect(snapshot.groups[0]).toMatchObject({ id: 'g1', author: '张三', announcedAt: 456 });
    expect(snapshot.updatedAtMs).toBe(123);
  });

  it('keeps readable edits and drops the ones it cannot apply', () => {
    const snapshot = normalizeSnapshot({
      edits: [
        { id: 'dev:2026-10-20', groupId: 'g1', key: 'dev', start: '2026-10-22', end: '2026-10-24', at: 9 },
        // 起止倒置、缺字段、日期不是真日期，都读不出来
        { id: 'dev:2026-10-20', groupId: 'g1', key: 'dev', start: '2026-10-24', end: '2026-10-22' },
        { id: 'dev:2026-10-20', key: 'dev', start: '2026-10-22', end: '2026-10-24' },
        { id: 'x:2026-02-30', groupId: 'g1', key: 'dev', start: '2026-02-30', end: '2026-03-02' },
        'not-a-record',
      ],
    });
    expect(snapshot.edits).toEqual([
      { id: 'dev:2026-10-20', groupId: 'g1', key: 'dev', added: false, start: '2026-10-22', end: '2026-10-24', at: 9 },
    ]);
  });

  it('an older file without edits just has none', () => {
    expect(normalizeSnapshot({ groups: [] }).edits).toEqual([]);
    expect(emptySnapshot().edits).toEqual([]);
  });
});
