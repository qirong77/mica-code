import { addDays } from './gantt.js';
import { daysBetween, STAGE_LABELS, type ScheduleStage } from './parse.js';
import type { ScheduleGroup } from './refresh.js';

/**
 * 本地修订层：用户把条拖到别的日子，记在这里，不动物业公告本身。
 *
 * 为什么单独一层而不是直接改 `groups`：
 *
 * - `groups` 是群公告的解析结果，下一轮整理会整份重写，改了等于没改；
 * - 公告是别人写的，用户的手动调整只是「我这边的看法」，得能一眼看出哪条动过、能还原；
 * - 公告改了（同一条阶段的日期变了）说明源头信息更新了，那条修订就该作废，不该继续盖着。
 *
 * 所以身份按「公告里那条阶段」定：`key:start`。用户拖过之后 `start` 变了，但 id 仍是
 * 公告里那一天的，下一轮整理还能对上。新建的条没有告基地阶段，id 用 `new:` 前缀。
 */

export type ScheduleEdit = {
  /** 稳定身份：公告阶段 `key:公告里的起始日`；新建的条 `new:key:时间戳`。 */
  id: string;
  /** 挂在哪个群（`ScheduleGroup.id`）下。 */
  groupId: string;
  /** 阶段类型，新建时靠它决定标签与配色。 */
  key: string;
  /** 用户新加的条（公告里没有）；改现有条时为 false。 */
  added: boolean;
  /** 改后的区间，`YYYY-MM-DD`，含首尾。 */
  start: string;
  end: string;
  /** 最后一次改动时间（毫秒），只用于排查。 */
  at: number;
};

/** 公告里一条阶段的身份。两个字段都来自解析结果，所以下一轮整理对得上就是同一条。 */
export function stageIdOf(stage: Pick<ScheduleStage, 'key' | 'start'>): string {
  return `${stage.key}:${stage.start}`;
}

/** 新建的条用时间戳做后缀，同一天新建两条同阶段的条也不会撞。 */
export function newStageId(key: string, at: number): string {
  return `new:${key}:${at}`;
}

/** 应用过修订的阶段：多带身份与「动过」的痕迹，界面靠它们画虚线与还原。 */
export type EditedStage = ScheduleStage & {
  stageId: string;
  edited: boolean;
  added: boolean;
  /** 公告里的原区间，只在 `edited` 时有；「还原」按钮显示的就是它。 */
  originalStart?: string;
  originalEnd?: string;
};

function enumerate(start: string, end: string): string[] {
  const span = daysBetween(start, end);
  if (span <= 0) return [start];
  return Array.from({ length: span + 1 }, (_, index) => addDays(start, index));
}

/**
 * 把修订盖到解析结果上，得到界面要画的那份。
 *
 * 不修改入参：`snapshot.groups` 是磁盘那一份的投影，下一轮刷新还要拿它做对比。
 */
export function applyEdits(
  groups: ScheduleGroup[],
  edits: ScheduleEdit[],
): Array<ScheduleGroup & { stages: EditedStage[] }> {
  return groups.map((group) => {
    const stages: EditedStage[] = group.stages.map((stage) => ({
      ...stage,
      stageId: stageIdOf(stage),
      edited: false,
      added: false,
    }));

    for (const edit of edits) {
      if (edit.groupId !== group.id) continue;
      if (edit.added) {
        // 已经在本组里（同一次渲染被应用过）就不再重复加
        if (stages.some((stage) => stage.stageId === edit.id)) continue;
        stages.push({
          key: edit.key,
          label: STAGE_LABELS[edit.key] ?? edit.key,
          start: edit.start,
          end: edit.end,
          days: enumerate(edit.start, edit.end),
          range: true,
          stageId: edit.id,
          edited: true,
          added: true,
        });
        continue;
      }
      // 公告里同 key 同日的重复阶段会一起改：它们本来就分不出彼此
      for (const stage of stages) {
        if (stage.stageId !== edit.id) continue;
        stage.originalStart = stage.start;
        stage.originalEnd = stage.end;
        stage.start = edit.start;
        stage.end = edit.end;
        stage.days = enumerate(edit.start, edit.end);
        stage.range = true;
        stage.edited = true;
      }
    }

    return { ...group, stages };
  });
}

/** 写入一条修订：同身份覆盖，其余保持原样。 */
export function upsertEdit(edits: ScheduleEdit[], edit: ScheduleEdit): ScheduleEdit[] {
  const next = edits.filter((item) => !(item.groupId === edit.groupId && item.id === edit.id));
  next.push(edit);
  return next;
}

/** 去掉一条修订（还原成公告值，或删掉自己新建的条）。 */
export function dropEdit(edits: ScheduleEdit[], groupId: string, id: string): ScheduleEdit[] {
  return edits.filter((item) => !(item.groupId === groupId && item.id === id));
}

/**
 * 整理完丢掉对不上的修订。
 *
 * 改现有条的那种，基地阶段没了（公告删了这条）或日期变了（id 跟着变）就作废——继续盖着
 * 只会让「公告已经更新」这件事看不出来。新建的条只要那个群还在就留着。
 */
export function pruneEdits(
  groups: Array<{ id: string; stages: ScheduleStage[] }>,
  edits: ScheduleEdit[],
): ScheduleEdit[] {
  const byId = new Map<string, Set<string>>();
  for (const group of groups) {
    byId.set(group.id, new Set(group.stages.map((stage) => stageIdOf(stage))));
  }
  return edits.filter((edit) => {
    const ids = byId.get(edit.groupId);
    if (!ids) return false;
    return edit.added || ids.has(edit.id);
  });
}

export type DragMode = 'move' | 'start' | 'end';

/**
 * 拖动换算：拖条体整体平移，拖两端只改那一端。
 *
 * 最小一天：拖过头把起点拖到终点右边时停在同一天，而不是让区间翻过来——翻转没有意义，
 * 还会让条瞬间跳到对面。
 */
export function dragRange(input: {
  mode: DragMode;
  baseStart: string;
  baseEnd: string;
  /** 相对按下位置的整天数（半数以上算一天，由调用方取整） */
  deltaDays: number;
}): { start: string; end: string } {
  const { mode, baseStart, baseEnd, deltaDays } = input;
  if (deltaDays === 0) return { start: baseStart, end: baseEnd };
  if (mode === 'move') return { start: addDays(baseStart, deltaDays), end: addDays(baseEnd, deltaDays) };
  if (mode === 'start') {
    const start = addDays(baseStart, deltaDays);
    return { start: start > baseEnd ? baseEnd : start, end: baseEnd };
  }
  const end = addDays(baseEnd, deltaDays);
  return { start: baseStart, end: end < baseStart ? baseStart : end };
}

/** 区间能不能落到这份修订上：真日期（2 月 30 这种会被换算掉）、起止不倒置。 */
export function isValidRange(start: string, end: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return false;
  if (addDays(start, 0) !== start || addDays(end, 0) !== end) return false;
  return daysBetween(start, end) >= 0;
}
