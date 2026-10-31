import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { emptyData, normalizeData, stamp, type ScheduleData } from './schedule.js';

/**
 * `data.json` 的读写。
 *
 * 写它的有三个来源：桌面端页面（经宿主 `plugin-host:write-data`）、`schedule` 工具（就在这里）、
 * 配置页的动作（也可以算页面那一路）。三者互不相识，只共用两样东西：
 *
 * - **同一个锁文件** `${data}.lock`（宿主的写入口用的也是这个路径）；
 * - **先写临时文件再 rename**，页面随时在读，不能让它读到半份 JSON。
 *
 * 所以工具这边拿到锁之后是「现读 → 改一条 → 原子写」，而不是把内存里那份整份盖回去：
 * 用户可能刚拖过另一条。
 */

export const SCHEDULE_DATA_FILE = 'data.json';

const LOCK_ATTEMPTS = 6;
const LOCK_RETRY_MS = 80;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function readScheduleData(file: string): ScheduleData {
  try {
    return normalizeData(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return emptyData();
  }
}

export function writeScheduleData(file: string, data: ScheduleData): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * 在跨进程锁里读改写一次，返回这次改动的说明。
 *
 * `mutate` 抛错就原样抛出去（id 过期、日期不合法这类要给模型/用户看到的原因）；
 * 只有「拿不到锁」才重试——另一个窗口正在写是暂时的，等几十毫秒就好。
 */
export async function mutateSchedule(
  file: string,
  mutate: (data: ScheduleData) => { data: ScheduleData; message: string },
): Promise<string> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    const release = acquireProcessLock(`${file}.lock`);
    if (!release) {
      await sleep(LOCK_RETRY_MS);
      continue;
    }
    try {
      const result = mutate(readScheduleData(file));
      writeScheduleData(file, stamp(result.data));
      return result.message;
    } finally {
      release();
    }
  }
  throw new Error('排期正在保存（另一个窗口在写），稍后再试一次');
}
