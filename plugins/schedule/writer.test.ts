import { describe, expect, it, vi } from 'vitest';
import { applyOperation, emptyData, type ScheduleData, type ScheduleOperation } from './schedule.js';
import { createScheduleWriter, type ScheduleHost } from './writer.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function initial(): ScheduleData {
  return {
    ...emptyData(),
    tasks: [
      { id: 't1', name: '开发', start: '2026-11-02', end: '2026-11-06', color: 'blue', note: '' },
      { id: 't2', name: '测试', start: '2026-11-09', end: '2026-11-12', color: 'amber', note: '' },
    ],
  };
}

/**
 * 假宿主：和真实的 `plugin-host:read-data|write-data` 一样带版本号，写入是「整份替换」。
 * 测试可以读到磁盘当前内容、也可以在两次调用之间模拟另一个写入者。
 */
function fixture(start: ScheduleData = initial()) {
  let disk = clone(start);
  let version = 0;
  const readData = vi.fn<ScheduleHost['readData']>(async () => ({
    ok: true,
    value: clone(disk),
    version: `v${version}`,
  }));
  const writeData = vi.fn<ScheduleHost['writeData']>(async (value, options) => {
    if ((options?.expectedVersion ?? null) !== `v${version}`) return { ok: false, conflict: true, error: 'conflict' };
    disk = clone(value as ScheduleData);
    version += 1;
    return { ok: true };
  });
  const host: ScheduleHost = { readData, writeData };
  return {
    host,
    writeData,
    disk: () => disk,
    /** 模拟另一个写入者（模型 / 另一个窗口）改一条，版本随之前进。 */
    otherWriter(operation: ScheduleOperation) {
      disk = clone(applyOperation(disk, operation));
      version += 1;
    },
  };
}

describe('createScheduleWriter', () => {
  it('serializes queued edits so the second one is computed on top of the first', async () => {
    const page = fixture();
    const errors: string[] = [];
    const writer = createScheduleWriter({ host: page.host, onError: (message) => errors.push(message) });

    writer.push({ type: 'update-task', taskId: 't1', start: '2026-11-03', end: '2026-11-07' });
    writer.push({ type: 'update-task', taskId: 't2', start: '2026-11-10', end: '2026-11-13' });

    await expect(writer.flush()).resolves.toBe(true);
    const tasks = page.disk().tasks;
    expect(tasks.map((task) => [task.start, task.end])).toEqual([
      ['2026-11-03', '2026-11-07'],
      ['2026-11-10', '2026-11-13'],
    ]);
    expect(errors).toEqual([]);
    expect(writer.pending()).toBe(0);
  });

  it('replays its own edit on top of a conflicting write from another window', async () => {
    const page = fixture();
    const errors: string[] = [];
    const write = page.writeData.getMockImplementation()!;
    page.writeData.mockImplementationOnce(async () => {
      // 另一个窗口刚好把「测试」挪走了：这一条必须保留下来
      page.otherWriter({ type: 'update-task', taskId: 't2', start: '2026-11-16', end: '2026-11-18' });
      return { ok: false, conflict: true, error: 'conflict' };
    });
    page.writeData.mockImplementation(write);

    const writer = createScheduleWriter({ host: page.host, onError: (message) => errors.push(message) });
    writer.push({ type: 'update-task', taskId: 't1', start: '2026-11-03', end: '2026-11-07' });
    await expect(writer.flush()).resolves.toBe(true);

    const tasks = page.disk().tasks;
    expect(tasks[0]).toMatchObject({ id: 't1', start: '2026-11-03', end: '2026-11-07' });
    expect(tasks[1]).toMatchObject({ id: 't2', start: '2026-11-16', end: '2026-11-18' });
    expect(errors).toEqual([]);
  });

  it('reports a failed write and stops the queue instead of writing the rest blindly', async () => {
    const page = fixture();
    const errors: string[] = [];
    const writer = createScheduleWriter({ host: page.host, onError: (message) => errors.push(message) });
    page.writeData.mockImplementation(async () => ({ ok: false, error: '磁盘满了' }));

    writer.push({ type: 'delete-task', taskId: 't1' });
    writer.push({ type: 'delete-task', taskId: 't2' });
    await expect(writer.flush()).resolves.toBe(false);
    expect(errors).toEqual(['磁盘满了']);
    expect(writer.pending()).toBe(0);
    expect(page.disk().tasks).toHaveLength(2);
  });

  it('reports a missing target (deleted by someone else) instead of retrying forever', async () => {
    const page = fixture();
    const errors: string[] = [];
    const writer = createScheduleWriter({ host: page.host, onError: (message) => errors.push(message) });
    await expect(
      (async () => {
        writer.push({ type: 'delete-task', taskId: 'gone' });
        return writer.flush();
      })(),
    ).resolves.toBe(false);
    expect(errors[0]).toContain('这个任务已经不在了');
  });
});
