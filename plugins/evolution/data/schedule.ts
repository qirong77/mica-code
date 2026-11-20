import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { writeTextFileAtomic } from '@packages/mica-config/atomicWrite.js';
import {
  DEFAULT_TITLE,
  MAX_NAME_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_TASKS,
  SCALES,
  SCHEDULE_VERSION,
  normalizeScale,
  normalizeZoom,
  summarize,
  type ScheduleData,
  type ScheduleTask,
} from '../../schedule/schedule.js';
import { isValidRange } from '../../schedule/dates.js';
import { isScheduleColor, nextColor, type ScheduleColor } from '../../schedule/palette.js';
import { archivePrivateOriginal } from './private-files.js';
import type { DataMigration } from './types.js';

const DATA_FILE = join('plugin-data', 'schedule', 'data.json');

function record(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, limit: number, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit) throw new Error(message);
  return value.trim();
}

function optionalText(value: unknown, limit: number, message: string): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > limit) throw new Error(message);
  return value.trim();
}

function legacyTask(
  stage: Record<string, unknown>,
  plan: Record<string, unknown>,
  planIndex: number,
  stageIndex: number,
  color: ScheduleColor,
  ids: Set<string>,
): ScheduleTask {
  const name = requiredText(stage.name, MAX_NAME_LENGTH, '旧排期阶段名称不合法');
  const start = requiredText(stage.start, 10, '旧排期阶段开始日期不合法');
  const end = stage.end === undefined ? start : requiredText(stage.end, 10, '旧排期阶段结束日期不合法');
  if (!isValidRange(start, end)) throw new Error('旧排期阶段日期范围不合法');

  let id =
    stage.id === undefined
      ? `legacy-${planIndex}-${stageIndex}`
      : requiredText(stage.id, MAX_NAME_LENGTH, '旧排期阶段 id 不合法');
  if (ids.has(id)) throw new Error(`旧排期阶段 id 重复：${id}`);
  ids.add(id);

  const planName = optionalText(plan.name, MAX_NAME_LENGTH, '旧排期计划名称不合法');
  const planNote = optionalText(plan.note, MAX_NOTE_LENGTH, '旧排期计划备注不合法');
  const stageNote = optionalText(stage.note, MAX_NOTE_LENGTH, '旧排期阶段备注不合法');
  const taskColor = isScheduleColor(stage.color) ? stage.color : isScheduleColor(plan.color) ? plan.color : color;
  const note =
    stageIndex === 0 && planNote && stageNote ? `${planNote}\n\n${stageNote}` : stageIndex === 0 ? planNote : stageNote;
  return {
    id,
    name: (planName ? `${planName} · ${name}` : name).slice(0, MAX_NAME_LENGTH),
    start,
    end,
    color: taskColor,
    note: note.slice(0, MAX_NOTE_LENGTH),
  };
}

function migrateLegacy(value: unknown): ScheduleData {
  const raw = record(value, '旧排期不是对象');
  if (raw.version !== 1 || raw.tasks !== undefined || !Array.isArray(raw.plans))
    throw new Error('不是明确的 plans/stages 旧排期形态');
  const tasks: ScheduleTask[] = [];
  const ids = new Set<string>();
  for (const [planIndex, entry] of raw.plans.entries()) {
    const plan = record(entry, '旧排期计划不合法');
    if (!Array.isArray(plan.stages)) throw new Error('旧排期计划缺少 stages 数组');
    if (tasks.length + plan.stages.length > MAX_TASKS) throw new Error(`旧排期任务超过 ${MAX_TASKS} 条`);
    const color = nextColor(planIndex);
    for (const [stageIndex, stageEntry] of plan.stages.entries()) {
      tasks.push(legacyTask(record(stageEntry, '旧排期阶段不合法'), plan, planIndex, stageIndex, color, ids));
    }
  }

  const updatedAtMs = raw.updatedAtMs === undefined ? 0 : raw.updatedAtMs;
  if (typeof updatedAtMs !== 'number' || !Number.isFinite(updatedAtMs)) throw new Error('旧排期 updatedAtMs 不合法');
  const updatedAt =
    raw.updatedAt === undefined ? '' : optionalText(raw.updatedAt, Number.MAX_SAFE_INTEGER, '旧排期 updatedAt 不合法');
  const title =
    raw.title === undefined ? DEFAULT_TITLE : optionalText(raw.title, 40, '旧排期标题不合法') || DEFAULT_TITLE;
  if (raw.scale !== undefined && !(SCALES as readonly unknown[]).includes(raw.scale))
    throw new Error('旧排期刻度不合法');
  if (raw.zoom !== undefined && (typeof raw.zoom !== 'number' || !Number.isFinite(raw.zoom)))
    throw new Error('旧排期缩放不合法');
  const data: ScheduleData = {
    version: SCHEDULE_VERSION,
    updatedAtMs,
    updatedAt,
    summary: summarize(tasks),
    title,
    scale: normalizeScale(raw.scale),
    zoom: normalizeZoom(raw.zoom),
    tasks,
  };
  return data;
}

export const schedulePlansStages: DataMigration = {
  id: 'schedule-plans-stages',
  description: '将 Schedule 旧 plans/stages 数据迁移为扁平 tasks，并归档无法映射的原文',
  run({ home, log }) {
    const file = join(home, DATA_FILE);
    try {
      if (!lstatSync(file).isFile()) return 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }

    const release = acquireProcessLock(`${file}.lock`);
    if (!release) return 0;
    try {
      const original = Buffer.from(readFileSync(file));
      const value: unknown = JSON.parse(original.toString('utf8'));
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        (value as Record<string, unknown>).tasks !== undefined ||
        !Array.isArray((value as Record<string, unknown>).plans)
      ) {
        return 0;
      }
      const migrated = migrateLegacy(value);
      const serialized = `${JSON.stringify(migrated, null, 2)}\n`;
      // Archive first. If validation, archiving, or writing fails, the source remains untouched.
      archivePrivateOriginal(home, 'legacy-schedule', 'data.json', original);
      writeTextFileAtomic(file, serialized);
      log('evolution:schedule-migrated', { tasks: migrated.tasks.length });
      return 1;
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('Schedule 旧排期 JSON 损坏，原文件未改写');
      throw error;
    } finally {
      release();
    }
  },
};
