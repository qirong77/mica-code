import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import type { DataMigration } from './types.js';

/**
 * 会话标签的旧形态：7 个固定色槽（id 是颜色名、名字是默认英文名）。
 *
 * 标签改成用户自由定义之后这些槽位没有意义了。只清掉「没改过名、也没挂过任何会话」的
 * 那几个：改过名说明用户真的用它表达过某个分类，删掉等于删他的数据。
 *
 * 这一步以前放在标签插件的启动归一化里（每次都把收敛结果写回文件），属于运行时兼容分支。
 * 旧数据只有那一批，改成这里一次性迁移之后，运行时只做「读到畸形文件也能画」的容错。
 */
const LEGACY_SLOTS: Record<string, string> = {
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
  gray: 'Gray',
};

/** 只剩没用过的旧色槽时落下的那一个标签，与插件首次运行预置的一致。 */
const SEED_OPTION = { id: 'tag-1', label: '待 review', color: '#FF9500' };

const STORE_NAME = 'Session Tags';
const DEFAULT_COLOR = '#FF9500';
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_LABEL = 24;
const MAX_TAGS = 24;
const MAX_TAGS_PER_SESSION = 16;

type TagOption = { id: string; label: string; color: string };

export const sessionTagSlots: DataMigration = {
  id: 'session-tags-slots',
  description: '清掉标签表里没用过的旧固定色槽（只剩它们时换成「待 review」），并收敛指向已删标签的归属',
  run({ home }) {
    const file = join(home, 'plugin-data', 'session-tags', 'session-annotations.json');
    if (!existsSync(file)) return 0;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      // 坏文件交给插件自己的归一化与报错，迁移不覆盖它（覆盖等于把用户的标签清空）。
      return 0;
    }
    const next = converge(raw);
    if (!next) return 0;
    writeTextFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
    return 1;
  },
};

/** 需要改写时返回收敛后的表，已经是当前形态时返回 null。 */
function converge(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const rawOptions = Array.isArray(record.options) ? record.options : [];
  const rawAssignments =
    record.assignments && typeof record.assignments === 'object' && !Array.isArray(record.assignments)
      ? (record.assignments as Record<string, unknown>)
      : {};

  const used = new Set<string>();
  for (const ids of Object.values(rawAssignments)) {
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') used.add(id.trim());
  }

  const options: TagOption[] = [];
  const seen = new Set<string>();
  for (const entry of rawOptions.slice(0, MAX_TAGS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const option = entry as Record<string, unknown>;
    const id = typeof option.id === 'string' ? option.id.trim() : '';
    const label = typeof option.label === 'string' ? option.label.trim().slice(0, MAX_LABEL) : '';
    if (!id || !label || seen.has(id)) continue;
    if (LEGACY_SLOTS[id] === label && !used.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      label,
      color: typeof option.color === 'string' && HEX_COLOR.test(option.color) ? option.color : DEFAULT_COLOR,
    });
  }

  // 只剩一堆没动过的旧色槽：算「还没定义过标签」，给一个默认的。用户自己把标签删空时
  // 文件里是 `options: []`，不走这条，也就不会在升级时长回来。
  if (options.length === 0 && rawOptions.length > 0 && rawOptions.every(isLegacyDefault)) {
    options.push({ ...SEED_OPTION });
  }

  const order = new Map(options.map((option, index) => [option.id, index]));
  const assignments: Record<string, string[]> = {};
  for (const [sessionId, ids] of Object.entries(rawAssignments)) {
    const session = sessionId.trim();
    if (!session || !Array.isArray(ids)) continue;
    const kept = [...new Set(ids.filter((item): item is string => typeof item === 'string' && order.has(item)))];
    if (kept.length === 0) continue;
    assignments[session] = kept
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      .slice(0, MAX_TAGS_PER_SESSION);
  }

  const next = { version: 1, name: STORE_NAME, options, assignments };
  return JSON.stringify(next) === JSON.stringify(normalizeForCompare(record)) ? null : next;
}

function isLegacyDefault(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const option = entry as Record<string, unknown>;
  const id = typeof option.id === 'string' ? option.id.trim() : '';
  const label = typeof option.label === 'string' ? option.label.trim().slice(0, MAX_LABEL) : '';
  return LEGACY_SLOTS[id] === label;
}

/**
 * 只保留迁移关心的四个字段再比较：文件里多出来的键（用户手加、旧版本残留）不算改动，
 * 否则每次启动都会因为「键不一样」重写一遍。
 */
function normalizeForCompare(record: Record<string, unknown>): Record<string, unknown> {
  return {
    version: typeof record.version === 'number' ? record.version : undefined,
    name: typeof record.name === 'string' ? record.name : undefined,
    options: Array.isArray(record.options) ? record.options : [],
    assignments:
      record.assignments && typeof record.assignments === 'object' && !Array.isArray(record.assignments)
        ? record.assignments
        : {},
  };
}
