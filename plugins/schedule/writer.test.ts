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

  describe.each([
    { method: 'readData', message: '读取排期失败', writeCalls: 0 },
    { method: 'writeData', message: '保存排期失败', writeCalls: 1 },
  ] as const)('$method failure', ({ method, message, writeCalls }) => {
    it.each(['response', 'rejection', 'throw'] as const)(
      'reports a %s once, clears the queue and permits later saves',
      async (failure) => {
        const page = fixture();
        const errors: string[] = [];
        const writer = createScheduleWriter({ host: page.host, onError: (message) => errors.push(message) });
        const hostCall = vi.mocked(page.host[method]);
        const detail = '存储不可用';
        if (failure === 'response') {
          hostCall.mockResolvedValueOnce({ ok: false, error: detail });
        } else if (failure === 'rejection') {
          hostCall.mockRejectedValueOnce(new Error(detail));
        } else {
          hostCall.mockImplementationOnce(() => {
            throw new Error(detail);
          });
        }

        writer.push({ type: 'delete-task', taskId: 't1' });
        writer.push({ type: 'delete-task', taskId: 't2' });
        await expect(writer.flush()).resolves.toBe(false);
        expect(errors).toEqual([failure === 'response' ? detail : `${message}：${detail}`]);
        expect(page.host.readData).toHaveBeenCalledTimes(1);
        expect(page.writeData).toHaveBeenCalledTimes(writeCalls);
        expect(writer.pending()).toBe(0);
        expect(page.disk()).toEqual(initial());

        // 失败的一批已丢弃，下一次显式编辑可以正常保存，不重放失败前的删除。
        writer.push({ type: 'update-task', taskId: 't1', name: '重新保存' });
        await expect(writer.flush()).resolves.toBe(true);
        expect(page.disk().tasks.map((task) => task.name)).toEqual(['重新保存', '测试']);
        expect(errors).toHaveLength(1);
        expect(writer.pending()).toBe(0);
      },
    );

    it('contains a rejected automatic save when push is not followed by an awaited flush', async () => {
      const page = fixture();
      const onError = vi.fn();
      const onUnhandledRejection = vi.fn();
      const writer = createScheduleWriter({ host: page.host, onError });
      vi.mocked(page.host[method]).mockRejectedValueOnce(new Error('自动保存失败'));

      process.on('unhandledRejection', onUnhandledRejection);
      try {
        writer.push({ type: 'delete-task', taskId: 't1' });
        writer.push({ type: 'delete-task', taskId: 't2' });
        // 让自动 flush 和未处理 rejection 检查完整走过一轮事件循环，不用 flush() 接住异常。
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(onUnhandledRejection).not.toHaveBeenCalled();
        expect(onError).toHaveBeenCalledExactlyOnceWith(`${message}：自动保存失败`);
        expect(page.host.readData).toHaveBeenCalledTimes(1);
        expect(page.writeData).toHaveBeenCalledTimes(writeCalls);
        expect(writer.pending()).toBe(0);
        expect(page.disk()).toEqual(initial());
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
    });
  });

  it('retries only conflicts and reports exhausted attempts once before discarding the queue', async () => {
    const page = fixture();
    const errors: string[] = [];
    const writer = createScheduleWriter({ host: page.host, onError: (message) => errors.push(message) });
    page.writeData.mockResolvedValue({ ok: false, conflict: true, error: 'conflict' });

    writer.push({ type: 'delete-task', taskId: 't1' });
    writer.push({ type: 'delete-task', taskId: 't2' });
    await expect(writer.flush()).resolves.toBe(false);
    expect(page.host.readData).toHaveBeenCalledTimes(8);
    expect(page.writeData).toHaveBeenCalledTimes(8);
    expect(errors).toEqual(['排期正在其他窗口更新，请稍后重试']);
    expect(writer.pending()).toBe(0);
    expect(page.disk()).toEqual(initial());
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
