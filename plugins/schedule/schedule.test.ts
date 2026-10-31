import { describe, expect, it } from 'vitest';
import {
  applyOperation,
  emptyData,
  formatSchedule,
  MAX_PLANS,
  normalizeData,
  stageHint,
  STAGE_NAMES,
  stamp,
  summarize,
  type ScheduleData,
  type SchedulePlan,
} from './schedule.js';

function plan(id: string, name: string, stages: SchedulePlan['stages'] = []): SchedulePlan {
  return { id, name, note: '', stages };
}

function dataWith(plans: SchedulePlan[]): ScheduleData {
  return { ...emptyData(), plans };
}

const TODAY = '2026-10-29';

describe('normalizeData', () => {
  it('returns an empty schedule for junk', () => {
    expect(normalizeData(null).plans).toEqual([]);
    expect(normalizeData('nope').plans).toEqual([]);
    expect(normalizeData({ plans: 'not-an-array' }).plans).toEqual([]);
  });

  it('drops plans and stages that cannot be drawn instead of losing everything', () => {
    const data = normalizeData({
      plans: [
        { id: 'a', name: '好计划', stages: [{ id: 's1', name: '开发', start: '2026-10-01', end: '2026-10-03' }] },
        { id: '', name: '没有 id' },
        { id: 'a', name: '重复 id' },
        {
          id: 'b',
          name: '坏阶段',
          stages: [
            { id: 's2', name: '测试', start: '2026-02-30', end: '2026-03-02' },
            { id: 's3', name: '倒着写', start: '2026-10-05', end: '2026-10-01' },
            { id: 's4', name: '只有开始', start: '2026-10-06' },
            { id: 's1', name: '跨计划重复 id', start: '2026-10-06', end: '2026-10-06' },
          ],
        },
      ],
    });
    expect(data.plans.map((item) => item.id)).toEqual(['a', 'b']);
    expect(data.plans[0]!.stages).toHaveLength(1);
    // 「只有开始」按一天处理；重复的 stage id 丢弃（阶段 id 全局唯一，界面靠它定位）
    expect(data.plans[1]!.stages).toEqual([{ id: 's4', name: '只有开始', start: '2026-10-06', end: '2026-10-06' }]);
  });

  it('keeps a note and rebuilds the summary when the file has none', () => {
    const data = normalizeData({ plans: [{ id: 'a', name: 'A', note: '  一句话  ', stages: [] }] });
    expect(data.plans[0]!.note).toBe('一句话');
    expect(data.summary).toBe('1 个计划 · 0 条阶段');
  });
});

describe('summarize / stamp', () => {
  it('counts plans and stages', () => {
    expect(summarize([])).toBe('还没有计划');
    expect(
      summarize([plan('a', 'A'), plan('b', 'B', [{ id: 's', name: '开发', start: '2026-10-01', end: '2026-10-02' }])]),
    ).toBe('2 个计划 · 1 条阶段');
  });

  it('stamps a human readable time and the summary', () => {
    const stamped = stamp(dataWith([plan('a', 'A')]), new Date(2026, 9, 29, 20, 40));
    expect(stamped).toMatchObject({ updatedAt: '10-29 20:40', summary: '1 个计划 · 0 条阶段' });
    expect(stamped.updatedAtMs).toBeGreaterThan(0);
  });
});

describe('applyOperation', () => {
  it('creates a plan, then a stage, without touching the input', () => {
    const before = emptyData();
    const created = applyOperation(before, { type: 'add-plan', plan: plan('p1', '钱包改版') });
    expect(before.plans).toEqual([]);
    expect(created.plans.map((item) => item.name)).toEqual(['钱包改版']);

    const withStage = applyOperation(created, {
      type: 'add-stage',
      planId: 'p1',
      stage: { id: 's1', name: '开发', start: '2026-11-02', end: '2026-11-06' },
    });
    expect(withStage.plans[0]!.stages).toEqual([{ id: 's1', name: '开发', start: '2026-11-02', end: '2026-11-06' }]);
  });

  it('treats a replayed add as the same item (write retries must not duplicate)', () => {
    const once = applyOperation(emptyData(), {
      type: 'add-plan',
      plan: plan('p1', '钱包改版'),
    });
    const twice = applyOperation(once, { type: 'add-plan', plan: plan('p1', '钱包改版（改名）') });
    expect(twice.plans).toHaveLength(1);
    expect(twice.plans[0]!.name).toBe('钱包改版（改名）');

    const stage = { id: 's1', name: '开发', start: '2026-11-02', end: '2026-11-06' };
    const added = applyOperation(twice, { type: 'add-stage', planId: 'p1', stage });
    const replayed = applyOperation(added, { type: 'add-stage', planId: 'p1', stage });
    expect(replayed.plans[0]!.stages).toHaveLength(1);
  });

  it('reschedules and renames a stage by id', () => {
    const data = dataWith([plan('p1', 'A', [{ id: 's1', name: '联调', start: '2026-11-02', end: '2026-11-06' }])]);
    const moved = applyOperation(data, { type: 'update-stage', stageId: 's1', start: '2026-11-09', end: '2026-11-13' });
    expect(moved.plans[0]!.stages[0]).toMatchObject({ start: '2026-11-09', end: '2026-11-13' });
    const renamed = applyOperation(moved, { type: 'update-stage', stageId: 's1', name: '联调（二期）' });
    expect(renamed.plans[0]!.stages[0]).toMatchObject({ name: '联调（二期）', start: '2026-11-09' });
  });

  it('rejects impossible ranges with a message a model can act on', () => {
    const data = dataWith([plan('p1', 'A', [{ id: 's1', name: '开发', start: '2026-11-02', end: '2026-11-06' }])]);
    expect(() => applyOperation(data, { type: 'update-stage', stageId: 's1', start: '2026-11-10' })).toThrow(
      '结束日期不能早于开始日期',
    );
    expect(() =>
      applyOperation(data, {
        type: 'add-stage',
        planId: 'p1',
        stage: { id: 's2', name: '测试', start: '2026-13-01', end: '2026-13-02' },
      }),
    ).toThrow('开始日期不是有效日期');
    expect(() => applyOperation(data, { type: 'update-stage', stageId: 's1', name: '   ' })).toThrow('名称不能为空');
  });

  it('tells the caller when the id it holds is gone', () => {
    const data = dataWith([plan('p1', 'A')]);
    expect(() => applyOperation(data, { type: 'update-plan', planId: 'p9', name: 'X' })).toThrow('这个计划已经不在了');
    expect(() => applyOperation(data, { type: 'delete-stage', stageId: 's9' })).toThrow('这条阶段已经不在了');
  });

  it('deletes a plan with its stages, and a single stage alone', () => {
    const data = dataWith([
      plan('p1', 'A', [
        { id: 's1', name: '开发', start: '2026-11-02', end: '2026-11-06' },
        { id: 's2', name: '测试', start: '2026-11-07', end: '2026-11-10' },
      ]),
      plan('p2', 'B'),
    ]);
    const withoutStage = applyOperation(data, { type: 'delete-stage', stageId: 's1' });
    expect(withoutStage.plans[0]!.stages.map((stage) => stage.id)).toEqual(['s2']);
    const withoutPlan = applyOperation(withoutStage, { type: 'delete-plan', planId: 'p1' });
    expect(withoutPlan.plans.map((item) => item.id)).toEqual(['p2']);
  });

  it('caps the number of plans', () => {
    const full = dataWith(Array.from({ length: MAX_PLANS }, (_, index) => plan(`p${index}`, `P${index}`)));
    expect(() => applyOperation(full, { type: 'add-plan', plan: plan('new', '新') })).toThrow(
      `计划最多 ${MAX_PLANS} 个`,
    );
  });

  it('clears a note when an empty string is passed', () => {
    const data = dataWith([{ id: 'p1', name: 'A', note: '旧备注', stages: [] }]);
    expect(applyOperation(data, { type: 'update-plan', planId: 'p1', note: '' }).plans[0]!.note).toBe('');
  });
});

describe('formatSchedule / stageHint', () => {
  it('lists plans with ids and per-stage hints so the model can edit straight away', () => {
    const text = formatSchedule(
      dataWith([
        plan('p1', '钱包改版', [
          { id: 's1', name: '开发', start: '2026-10-20', end: '2026-10-24' },
          { id: 's2', name: '测试', start: '2026-10-30', end: '2026-11-03' },
        ]),
        plan('p2', '空计划'),
      ]),
      TODAY,
    );
    expect(text).toContain(`今天 ${TODAY}`);
    expect(text).toContain('1. 钱包改版（p1）');
    expect(text).toContain('开发｜2026-10-20 → 2026-10-24｜5 天｜已结束 5 天｜s1');
    expect(text).toContain('测试｜2026-10-30 → 2026-11-03｜5 天｜明天开始｜s2');
    expect(text).toContain('（还没有阶段，用 add_stage 往里加）');
  });

  it('says the schedule is empty instead of printing nothing', () => {
    expect(formatSchedule(emptyData(), TODAY)).toBe(`今天 ${TODAY}\n排期是空的（还没有任何计划）。`);
  });

  it('describes a running stage by day', () => {
    const today = '2026-10-02';
    expect(stageHint({ start: '2026-10-01', end: '2026-10-03' }, today)).toBe('进行中，第 2/3 天');
  });

  it('ships the stage names the picker offers', () => {
    expect(STAGE_NAMES).toContain('开发');
    expect(STAGE_NAMES).toContain('上线');
  });
});
