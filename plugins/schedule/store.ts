import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import {
  emptyData,
  isLegacyPlanShape,
  MAX_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_TASKS,
  MAX_TITLE_LENGTH,
  normalizeData,
  SCALES,
  SCHEDULE_VERSION,
  stamp,
  type ScheduleData,
} from './schedule.js';
import { isValidRange } from './dates.js';
import { isScheduleColor } from './palette.js';

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
 * 用户可能刚拖过另一条任务。
 */

export const SCHEDULE_DATA_FILE = 'data.json';

const LOCK_ATTEMPTS = 6;
const LOCK_RETRY_MS = 80;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function invalidData(): Error {
  return Object.assign(new Error('排期文件损坏或结构不合法；请先修复或恢复文件，原文件未改写'), {
    code: 'invalid_data',
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidData();
  return value as Record<string, unknown>;
}

function optionalText(value: unknown, limit: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= limit);
}

/** normalizeData 用于显示/导入；存储基线必须先校验，不能静默丢掉坏任务再保存。 */
function storedData(value: unknown): ScheduleData {
  const raw = record(value);
  if (
    raw.version !== SCHEDULE_VERSION ||
    !optionalText(raw.title, MAX_TITLE_LENGTH) ||
    !optionalText(raw.updatedAt, Number.MAX_SAFE_INTEGER) ||
    !optionalText(raw.summary, Number.MAX_SAFE_INTEGER) ||
    (raw.updatedAtMs !== undefined && (typeof raw.updatedAtMs !== 'number' || !Number.isFinite(raw.updatedAtMs))) ||
    (raw.scale !== undefined && !(SCALES as readonly unknown[]).includes(raw.scale)) ||
    (raw.zoom !== undefined && (typeof raw.zoom !== 'number' || !Number.isFinite(raw.zoom)))
  )
    throw invalidData();

  // 保留现有已识别的 plans/stages 导入口径，不增加新形态；同样不得丢弃任何条目。
  const legacy = raw.tasks === undefined && isLegacyPlanShape(raw);
  const entries = legacy
    ? (raw.plans as unknown[]).flatMap((entry) => {
        const plan = record(entry);
        if (
          !Array.isArray(plan.stages) ||
          !optionalText(plan.name, MAX_NAME_LENGTH) ||
          !optionalText(plan.note, MAX_NOTE_LENGTH)
        )
          throw invalidData();
        return plan.stages;
      })
    : raw.tasks;
  if (!Array.isArray(entries) || entries.length > MAX_TASKS) throw invalidData();
  const ids = new Set<string>();
  for (const entry of entries) {
    const task = record(entry);
    if (
      (!legacy && (typeof task.id !== 'string' || !task.id.trim())) ||
      !optionalText(task.id, MAX_NAME_LENGTH) ||
      typeof task.name !== 'string' ||
      !task.name.trim() ||
      task.name.length > MAX_NAME_LENGTH ||
      typeof task.start !== 'string' ||
      task.start.length !== 10 ||
      (task.end !== undefined && (typeof task.end !== 'string' || task.end.length !== 10)) ||
      !isValidRange(task.start, typeof task.end === 'string' ? task.end : task.start) ||
      (task.color !== undefined && !isScheduleColor(task.color)) ||
      !optionalText(task.note, MAX_NOTE_LENGTH)
    )
      throw invalidData();
    if (typeof task.id === 'string') {
      const id = task.id.trim();
      if (!id || ids.has(id)) throw invalidData();
      ids.add(id);
    }
  }
  const data = normalizeData(raw);
  if (data.tasks.length !== entries.length) throw invalidData();
  return data;
}

export function readScheduleData(file: string): ScheduleData {
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyData();
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw invalidData();
  }
  return storedData(value);
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
