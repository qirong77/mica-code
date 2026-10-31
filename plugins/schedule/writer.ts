import { applyOperation, emptyData, normalizeData, stamp, type ScheduleOperation } from './schedule.js';

/**
 * 页面写盘的那条链。
 *
 * 排期同时可能被三个人改：这个窗口、另一个窗口、还有对话里的模型（`schedule` 工具）。
 * 所以页面不把内存里那份整份盖回去，而是排一条**操作**：拿锁外的最新数据（带版本号），
 * 把这一条改上去，再原子写。版本对不上就重读重放——别的窗口改的是别的任务时不会互相
 * 覆盖，改的是同一条则以最后保存的为准。
 *
 * 拖动、连续编辑会排进多条操作：写盘串行执行，每条都基于上一条的结果，所以不会出现
 * 「后一次读到前一次之前的版本」。
 */

export type ScheduleHost = {
  readData(): Promise<{ ok?: boolean; value?: unknown; version?: string | null; error?: string }>;
  writeData(
    value: unknown,
    options?: { expectedVersion?: string | null },
  ): Promise<{ ok?: boolean; conflict?: boolean; error?: string }>;
};

export type ScheduleWriter = {
  /** 排一条操作（会立刻开始写）。 */
  push(operation: ScheduleOperation): void;
  /** 排空队列；`false` 表示中途失败（原因已经经 `onError` 报出去）。 */
  flush(): Promise<boolean>;
  /** 还有几条没落盘。 */
  pending(): number;
};

/** 版本冲突时的重试上限：每次重试都基于最新数据重放这一条，正常两三次内就成。 */
const MAX_ATTEMPTS = 8;

export function createScheduleWriter(options: {
  host: ScheduleHost;
  onError?: (message: string) => void;
}): ScheduleWriter {
  const { host } = options;
  const queue: ScheduleOperation[] = [];
  let current: Promise<boolean> | null = null;

  const fail = (message: string): false => {
    options.onError?.(message);
    return false;
  };

  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  async function writeOperation(operation: ScheduleOperation): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      let result;
      try {
        result = await host.readData();
      } catch (error) {
        return fail(`读取排期失败：${errorText(error)}`);
      }
      if (result?.ok === false) return fail(result.error || '读取排期失败');
      const base = result?.value == null ? emptyData() : normalizeData(result.value);
      let next;
      try {
        next = stamp(applyOperation(base, operation));
      } catch (error) {
        return fail(errorText(error));
      }
      const saved = await host.writeData(next, { expectedVersion: result?.version ?? null });
      if (saved?.ok !== false) return true;
      if (!saved.conflict) return fail(saved.error || '保存排期失败');
    }
    return fail('排期正在其他窗口更新，请稍后重试');
  }

  async function drain(): Promise<boolean> {
    while (queue.length > 0) {
      const operation = queue[0]!;
      if (!(await writeOperation(operation))) {
        // 失败就停下并清空：继续写后面几条只会让错误更多、顺序更乱
        queue.length = 0;
        return false;
      }
      queue.shift();
    }
    return true;
  }

  function flush(): Promise<boolean> {
    if (!current) {
      const task = drain().finally(() => {
        if (current === task) current = null;
      });
      current = task;
    }
    return current;
  }

  return {
    push(operation) {
      queue.push(operation);
      void flush();
    },
    flush,
    pending() {
      return queue.length;
    },
  };
}
