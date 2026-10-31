import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { applyOperation, emptyData, normalizeData } from './schedule.js';
import { mutateSchedule, readScheduleData, writeScheduleData } from './store.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mica-schedule-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readScheduleData', () => {
  it('treats a missing file as an empty schedule', () => {
    expect(readScheduleData(join(dir, 'data.json').toString())).toMatchObject({ plans: [], summary: '' });
  });

  it('survives a hand-edited file', () => {
    const file = join(dir, 'data.json');
    writeFileSync(file, '{ not json', 'utf8');
    expect(readScheduleData(file).plans).toEqual([]);
  });
});

describe('writeScheduleData', () => {
  it('writes valid JSON that reads back unchanged', () => {
    const file = join(dir, 'nested', 'data.json');
    const data = applyOperation(emptyData(), {
      type: 'add-plan',
      plan: { id: 'p1', name: '钱包改版', note: '', stages: [] },
    });
    writeScheduleData(file, data);
    expect(normalizeData(JSON.parse(readFileSync(file, 'utf8')))).toEqual(data);
    expect(readScheduleData(file).plans.map((plan) => plan.name)).toEqual(['钱包改版']);
  });
});

describe('mutateSchedule', () => {
  it('reads, applies one operation, and stamps the result', async () => {
    const file = join(dir, 'data.json');
    writeScheduleData(file, emptyData());
    const message = await mutateSchedule(file, (data) => ({
      data: applyOperation(data, {
        type: 'add-stage',
        planId: 'p1',
        stage: { id: 's1', name: '开发', start: '2026-11-02', end: '2026-11-06' },
      }),
      message: 'ok',
    })).catch((error: unknown) => String(error));
    // 计划还不存在：这次应当失败而不是悄悄建一条孤儿阶段
    expect(String(message)).toContain('这个计划已经不在了');

    await mutateSchedule(file, (data) => ({
      data: applyOperation(data, { type: 'add-plan', plan: { id: 'p1', name: '钱包改版', note: '', stages: [] } }),
      message: '已新建',
    }));
    const saved = readScheduleData(file);
    expect(saved.plans.map((plan) => plan.id)).toEqual(['p1']);
    expect(saved.summary).toBe('1 个计划 · 0 条阶段');
    expect(saved.updatedAt).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('waits for the lock another window is holding instead of writing over it', async () => {
    const file = join(dir, 'data.json');
    writeScheduleData(file, emptyData());
    const release = acquireProcessLock(`${file}.lock`);
    expect(release).toBeTypeOf('function');

    const pending = mutateSchedule(file, (data) => ({
      data: applyOperation(data, { type: 'add-plan', plan: { id: 'p1', name: 'A', note: '', stages: [] } }),
      message: '已新建',
    }));
    // 锁还没放：那一刻应当还没写进去
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(readScheduleData(file).plans).toEqual([]);
    release!();
    await expect(pending).resolves.toBe('已新建');
    expect(readScheduleData(file).plans.map((plan) => plan.id)).toEqual(['p1']);
  });

  it('gives up with an actionable message when the lock never frees up', async () => {
    const file = join(dir, 'data.json');
    const release = acquireProcessLock(`${file}.lock`);
    await expect(mutateSchedule(file, () => ({ data: emptyData(), message: 'x' }))).rejects.toThrow('稍后再试一次');
    release!();
  });
});
