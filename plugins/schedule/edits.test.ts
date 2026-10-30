import { describe, expect, it } from 'vitest';
import {
  applyEdits,
  dragRange,
  dropEdit,
  isValidRange,
  newStageId,
  pruneEdits,
  stageIdOf,
  upsertEdit,
  type ScheduleEdit,
} from './edits.js';
import type { ScheduleGroup } from './refresh.js';

/**
 * 本地修订层：用户拖过的条要活过下一轮整理，公告变了要自动作废，身份不能跟着日期漂。
 */

function stage(key: string, start: string, end: string) {
  return {
    key,
    label: key,
    start,
    end,
    days: start === end ? [start] : [start, end],
    range: true,
  };
}

function group(id: string, stages: ReturnType<typeof stage>[]): ScheduleGroup {
  return { id, name: `群 ${id}`, author: '', announcedAt: 0, stages };
}

function edit(over: Partial<ScheduleEdit> = {}): ScheduleEdit {
  return {
    id: 'dev:2026-10-20',
    groupId: 'g1',
    key: 'dev',
    added: false,
    start: '2026-10-22',
    end: '2026-10-24',
    at: 1,
    ...over,
  };
}

describe('stageIdOf / newStageId', () => {
  it('身份只认阶段词与公告里的起始日', () => {
    expect(stageIdOf({ key: 'dev', start: '2026-10-20' })).toBe('dev:2026-10-20');
  });

  it('新建的条用时间戳区分，同一天建两条不会撞', () => {
    expect(newStageId('testing', 1)).not.toBe(newStageId('testing', 2));
    expect(newStageId('testing', 1).startsWith('new:testing:')).toBe(true);
  });
});

describe('applyEdits', () => {
  it('把修订盖上去，同时留下公告原值', () => {
    const groups = applyEdits([group('g1', [stage('dev', '2026-10-20', '2026-10-21')])], [edit()]);
    const [dev] = groups[0]!.stages;
    expect(dev!.start).toBe('2026-10-22');
    expect(dev!.end).toBe('2026-10-24');
    expect(dev!.edited).toBe(true);
    expect(dev!.added).toBe(false);
    expect(dev!.originalStart).toBe('2026-10-20');
    expect(dev!.originalEnd).toBe('2026-10-21');
    expect(dev!.days).toEqual(['2026-10-22', '2026-10-23', '2026-10-24']);
  });

  it('不修改入参：磁盘那份还要拿来对比', () => {
    const source = [group('g1', [stage('dev', '2026-10-20', '2026-10-21')])];
    applyEdits(source, [edit()]);
    expect(source[0]!.stages[0]!.start).toBe('2026-10-20');
  });

  it('没有修订的阶段原样返回，标成没动过', () => {
    const [g] = applyEdits([group('g1', [stage('dev', '2026-10-20', '2026-10-21')])], []);
    expect(g!.stages[0]).toMatchObject({ start: '2026-10-20', edited: false, added: false, stageId: 'dev:2026-10-20' });
  });

  it('新建的条追加到那个群里，不重复追加', () => {
    const added = edit({ id: 'new:testing:5', key: 'testing', added: true, start: '2026-11-01', end: '2026-11-01' });
    const groups = applyEdits([group('g1', [])], [added, added]);
    expect(groups[0]!.stages).toHaveLength(1);
    expect(groups[0]!.stages[0]).toMatchObject({ key: 'testing', added: true, edited: true, start: '2026-11-01' });
  });

  it('只改自己那个群', () => {
    const groups = applyEdits(
      [
        group('g1', [stage('dev', '2026-10-20', '2026-10-21')]),
        group('g2', [stage('dev', '2026-10-20', '2026-10-21')]),
      ],
      [edit()],
    );
    expect(groups[1]!.stages[0]!.start).toBe('2026-10-20');
    expect(groups[1]!.stages[0]!.edited).toBe(false);
  });

  it('公告里同 key 同日的重复阶段一起改：它们本来就分不出彼此', () => {
    const groups = applyEdits(
      [group('g1', [stage('testing', '2026-10-20', '2026-10-21'), stage('testing', '2026-10-20', '2026-10-21')])],
      [edit({ id: 'testing:2026-10-20', key: 'testing' })],
    );
    expect(groups[0]!.stages.every((item) => item.start === '2026-10-22')).toBe(true);
  });
});

describe('upsertEdit / dropEdit', () => {
  it('同一条再改一次就替换，不叠加', () => {
    const next = upsertEdit([edit()], { ...edit(), start: '2026-10-25', end: '2026-10-26' });
    expect(next).toHaveLength(1);
    expect(next[0]!.start).toBe('2026-10-25');
  });

  it('别的群或别的阶段不受影响', () => {
    const other = edit({ groupId: 'g2' });
    const next = upsertEdit([edit(), other], { ...edit(), start: '2026-10-25' });
    expect(next).toHaveLength(2);
    expect(next.find((item) => item.groupId === 'g2')).toEqual(other);
  });

  it('还原就是那条修订没了', () => {
    expect(dropEdit([edit(), edit({ groupId: 'g2' })], 'g1', 'dev:2026-10-20')).toEqual([edit({ groupId: 'g2' })]);
  });
});

describe('pruneEdits', () => {
  const groups = [group('g1', [stage('dev', '2026-10-20', '2026-10-21')])];

  it('对得上基地阶段就保留', () => {
    expect(pruneEdits(groups, [edit()])).toHaveLength(1);
  });

  it('公告改了日期（身份变了）就作废：源头信息更新了，修订不该继续盖着', () => {
    expect(pruneEdits(groups, [edit({ id: 'dev:2026-10-18' })])).toEqual([]);
  });

  it('群不在了就作废，新建的条也一样', () => {
    expect(pruneEdits([], [edit(), edit({ id: 'new:dev:1', added: true })])).toEqual([]);
  });

  it('新建的条只要群还在就留着', () => {
    expect(pruneEdits(groups, [edit({ id: 'new:dev:1', added: true })])).toHaveLength(1);
  });
});

describe('dragRange', () => {
  it('拖条体整体平移', () => {
    expect(dragRange({ mode: 'move', baseStart: '2026-10-20', baseEnd: '2026-10-22', deltaDays: 3 })).toEqual({
      start: '2026-10-23',
      end: '2026-10-25',
    });
  });

  it('拖左端只动开始', () => {
    expect(dragRange({ mode: 'start', baseStart: '2026-10-20', baseEnd: '2026-10-22', deltaDays: -2 })).toEqual({
      start: '2026-10-18',
      end: '2026-10-22',
    });
  });

  it('拖右端只动结束', () => {
    expect(dragRange({ mode: 'end', baseStart: '2026-10-20', baseEnd: '2026-10-22', deltaDays: 4 })).toEqual({
      start: '2026-10-20',
      end: '2026-10-26',
    });
  });

  it('拖过头就停在同一天，不让区间翻过来', () => {
    expect(dragRange({ mode: 'start', baseStart: '2026-10-20', baseEnd: '2026-10-22', deltaDays: 9 })).toEqual({
      start: '2026-10-22',
      end: '2026-10-22',
    });
    expect(dragRange({ mode: 'end', baseStart: '2026-10-20', baseEnd: '2026-10-22', deltaDays: -9 })).toEqual({
      start: '2026-10-20',
      end: '2026-10-20',
    });
  });

  it('没动就原样返回', () => {
    expect(dragRange({ mode: 'move', baseStart: '2026-10-20', baseEnd: '2026-10-22', deltaDays: 0 })).toEqual({
      start: '2026-10-20',
      end: '2026-10-22',
    });
  });
});

describe('isValidRange', () => {
  it('认 ISO 日期且起止不倒置', () => {
    expect(isValidRange('2026-10-20', '2026-10-20')).toBe(true);
    expect(isValidRange('2026-10-21', '2026-10-20')).toBe(false);
    expect(isValidRange('10.20', '2026-10-20')).toBe(false);
    expect(isValidRange('2026-02-30', '2026-03-01')).toBe(false);
  });
});
