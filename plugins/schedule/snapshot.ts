import type { ScheduleGroup } from './refresh.js';

/**
 * 卡片读的那份数据（`plugin-data/schedule/data.json`）。
 *
 * 同一个文件也是配置页「运行状态」的来源：清单里声明的 `status` 键按名字从这里取值，
 * 所以 `updatedAt`、`coverage` 是给人看的字符串，程序要用的时间戳另存 `updatedAtMs`。
 */

export const SCHEDULE_VERSION = 1;

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
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  };
}
