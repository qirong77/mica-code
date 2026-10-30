import type { ScheduleGroup } from './refresh.js';
import { isValidRange, type ScheduleEdit } from './edits.js';

/**
 * 卡片读的那份数据（`plugin-data/schedule/data.json`）。
 *
 * 同一个文件也是配置页「运行状态」的来源：清单里声明的 `status` 键按名字从这里取值，
 * 所以 `updatedAt`、`coverage` 是给人看的字符串，程序要用的时间戳另存 `updatedAtMs`。
 */

export const SCHEDULE_VERSION = 2;

export type ScheduleSnapshot = {
  version: number;
  /** 最近一次整理完成的时间（毫秒，0 表示还没整理过）。 */
  updatedAtMs: number;
  /** 同上，给人看：`10-29 20:40`。 */
  updatedAt: string;
  /** 覆盖情况，给人看：`扫了 55 个群 · 6 个有排期`。 */
  coverage: string;
  /** 当前登录的人（公告里不区分「谁的项目」，这里只用来显示）。 */
  me: string;
  scope: {
    days: number;
    scanned: number;
    /** 本轮计划要扫的群数；比 `scanned` 大说明没扫完。 */
    total: number;
    partial: boolean;
  };
  groups: ScheduleGroup[];
  /** 某个群没扫成的原因；展示时只取前几条。 */
  errors: Array<{ name: string; message: string }>;
  /**
   * 用户在本机上把条拖到别的日子留下的修订。
   *
   * 与 `groups` 分开存：`groups` 是群公告的解析结果，下一轮整理整份重写；修订要活过
   * 每一次整理，所以整理完只做一次「还对得上吗」的裁剪（见 `pruneEdits`）。
   */
  edits: ScheduleEdit[];
};

export function emptySnapshot(): ScheduleSnapshot {
  return {
    version: SCHEDULE_VERSION,
    updatedAtMs: 0,
    updatedAt: '',
    coverage: '还没有整理过',
    me: '',
    scope: { days: 0, scanned: 0, total: 0, partial: false },
    groups: [],
    errors: [],
    edits: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 读回的快照一律过一遍这里。
 *
 * 这份文件是插件自己写的，但它会跟着 `$MICA_HOME` 被拷来拷去、也可能被旧版本写过，卡片
 * 不该因为一个坏字段整块空掉：认不出的部分退回空值，能显示的照常显示。
 */
export function normalizeSnapshot(value: unknown): ScheduleSnapshot {
  const record = asRecord(value);
  if (!record) return emptySnapshot();
  const scope = asRecord(record.scope);
  const groups: ScheduleGroup[] = [];
  for (const entry of asArray(record.groups)) {
    const group = asRecord(entry);
    if (typeof group?.id !== 'string' || typeof group?.name !== 'string') continue;
    const stages = asArray(group.stages)
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((item) => ({
        key: typeof item.key === 'string' ? item.key : 'other',
        label: typeof item.label === 'string' ? item.label : '',
        start: typeof item.start === 'string' ? item.start : '',
        end: typeof item.end === 'string' ? item.end : '',
        days: asArray(item.days).filter((day): day is string => typeof day === 'string'),
        range: item.range !== false,
      }))
      .filter((item) => item.start && item.end);
    if (stages.length === 0) continue;
    groups.push({
      id: group.id,
      name: group.name,
      announcedAt: typeof group.announcedAt === 'number' ? group.announcedAt : 0,
      author: typeof group.author === 'string' ? group.author : '',
      stages,
    });
  }
  const errors = asArray(record.errors)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    .map((entry) => ({
      name: typeof entry.name === 'string' ? entry.name : '',
      message: typeof entry.message === 'string' ? entry.message : '',
    }))
    .filter((entry) => entry.name || entry.message);

  const edits: ScheduleEdit[] = [];
  for (const entry of asArray(record.edits)) {
    const edit = asRecord(entry);
    if (!edit) continue;
    const { id, groupId, key, start, end } = edit;
    if ([id, groupId, key, start, end].some((field) => typeof field !== 'string' || !field)) continue;
    if (!isValidRange(start as string, end as string)) continue;
    edits.push({
      id: id as string,
      groupId: groupId as string,
      key: key as string,
      added: edit.added === true,
      start: start as string,
      end: end as string,
      at: typeof edit.at === 'number' ? edit.at : 0,
    });
  }

  return {
    version: typeof record.version === 'number' ? record.version : SCHEDULE_VERSION,
    updatedAtMs: typeof record.updatedAtMs === 'number' ? record.updatedAtMs : 0,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    coverage: typeof record.coverage === 'string' ? record.coverage : '',
    me: typeof record.me === 'string' ? record.me : '',
    scope: {
      days: typeof scope?.days === 'number' ? scope.days : 0,
      scanned: typeof scope?.scanned === 'number' ? scope.scanned : 0,
      total: typeof scope?.total === 'number' ? scope.total : 0,
      partial: scope?.partial === true,
    },
    groups,
    errors,
    edits,
  };
}

/**
 * 首屏读数据的重试：宿主的 IPC 可能比页面晚一步就绪，一次读到空不该直接画「还没有整理过」
 * ——那会让人以为没数据，实际只是还没到。
 *
 * 只在读到空值时重试，且次数固定（默认 3 次 × 250ms）：真的没整理过时最多多等 0.75s，
 * 比让空态闪一下、用户以为插件坏了要好。读成功一次就立刻返回，不影响正常路径的时延。
 */
export type ReadRetryOptions = {
  attempts: number;
  delayMs: number;
  /** 便于测试注入，默认真的等 `delayMs`。 */
  wait?: (ms: number) => Promise<void>;
};

const defaultWait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export async function readWithRetry<T>(read: () => Promise<T | null>, options: ReadRetryOptions): Promise<T | null> {
  const wait = options.wait ?? defaultWait;
  const attempts = Math.max(1, options.attempts);
  let value = await read();
  for (let attempt = 1; value == null && attempt < attempts; attempt += 1) {
    await wait(options.delayMs);
    value = await read();
  }
  return value;
}
