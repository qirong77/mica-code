import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TITLE,
  MAX_TASKS,
  applyOperation,
  emptyData,
  exportDocument,
  formatSchedule,
  isLegacyPlanShape,
  normalizeData,
  parseImport,
  sampleData,
  stamp,
  summarize,
  taskHint,
  type ScheduleData,
  type ScheduleTask,
} from './schedule.js';

function task(
  id: string,
  name: string,
  start = '2026-10-01',
  end = start,
  extra: Partial<ScheduleTask> = {},
): ScheduleTask {
  return { id, name, start, end, color: 'blue', note: '', ...extra };
}

function dataWith(tasks: ScheduleTask[]): ScheduleData {
  return { ...emptyData(), tasks };
}

const TODAY = '2026-10-29';

describe('normalizeData', () => {
  it('returns an empty schedule for junk', () => {
    expect(normalizeData(null).tasks).toEqual([]);
    expect(normalizeData('nope').tasks).toEqual([]);
    expect(normalizeData({ tasks: 'not-an-array' }).tasks).toEqual([]);
  });

  it('drops tasks that cannot be drawn instead of losing everything', () => {
    const data = normalizeData({
      tasks: [
        task('a', '好任务'),
        { id: 'b', name: '坏日期', start: '2026-02-30', end: '2026-03-02' },
        { id: 'c', name: '倒着写', start: '2026-10-05', end: '2026-10-01' },
        { id: 'd', name: '只有开始', start: '2026-10-06' },
        { id: 'a', name: '重复 id', start: '2026-10-06' },
        { id: '', name: '没有 id', start: '2026-10-06' },
        { id: 'e', name: '没颜色', color: 'bogus', start: '2026-10-07' },
      ],
    });
    expect(data.tasks.map((item) => item.id)).toEqual(['a', 'd', 'e']);
    // 「只有开始」按一天处理；认不出的颜色落回蓝色
    expect(data.tasks[1]).toMatchObject({ id: 'd', start: '2026-10-06', end: '2026-10-06' });
    expect(data.tasks[2]).toMatchObject({ id: 'e', color: 'blue' });
  });

  it('reads back the saved zoom factor, falling back to 1', () => {
    expect(normalizeData({ ...emptyData(), zoom: 3 }).zoom).toBe(3);
    expect(normalizeData({ tasks: [] }).zoom).toBe(1);
    expect(normalizeData({ tasks: [], zoom: 'twice' }).zoom).toBe(1);
    expect(normalizeData({ tasks: [], zoom: 100 }).zoom).toBe(6);
    // 滚轮连乘出来的浮点尾巴收成三位小数
    expect(normalizeData({ tasks: [], zoom: 2.5919999999999996 }).zoom).toBe(2.592);
  });

  it('falls back to a default title / day scale and rebuilds the summary', () => {
    const data = normalizeData({ tasks: [task('a', 'A', '2026-10-01', '2026-10-01', { note: '  一句话  ' })] });
    expect(data.title).toBe(DEFAULT_TITLE);
    expect(data.scale).toBe('day');
    expect(data.tasks[0]!.note).toBe('一句话');
    expect(data.summary).toBe('1 个任务');
  });

  it('migrates the old plans/stages shape into flat tasks', () => {
    const raw = {
      version: 1,
      summary: '2 个计划 · 3 条阶段',
      plans: [
        {
          id: 'p1',
          name: '钱包改版',
          note: '11 月上线',
          stages: [
            { id: 's1', name: '评审', start: '2026-10-28', end: '2026-10-29' },
            { id: 's2', name: '开发', start: '2026-11-01', end: '2026-11-10' },
          ],
        },
        { id: 'p2', name: '官网', note: '', stages: [{ id: 's3', name: '设计', start: '2026-11-02' }] },
      ],
    };
    const data = normalizeData(raw);
    expect(isLegacyPlanShape(raw)).toBe(true);
    expect(data.tasks).toEqual([
      { id: 's1', name: '钱包改版 · 评审', start: '2026-10-28', end: '2026-10-29', color: 'blue', note: '11 月上线' },
      { id: 's2', name: '钱包改版 · 开发', start: '2026-11-01', end: '2026-11-10', color: 'blue', note: '' },
      { id: 's3', name: '官网 · 设计', start: '2026-11-02', end: '2026-11-02', color: 'violet', note: '' },
    ]);
    expect(data.summary).toBe('3 个任务');
    expect(isLegacyPlanShape({ tasks: [] })).toBe(false);
  });
});

describe('summarize / stamp', () => {
  it('counts tasks', () => {
    expect(summarize([])).toBe('还没有任务');
    expect(summarize([task('a', 'A'), task('b', 'B')])).toBe('2 个任务');
  });

  it('stamps a human readable time and the summary', () => {
    const stamped = stamp(dataWith([task('a', 'A')]), new Date(2026, 9, 29, 20, 40));
    expect(stamped).toMatchObject({ updatedAt: '10-29 20:40', summary: '1 个任务' });
    expect(stamped.updatedAtMs).toBeGreaterThan(0);
  });
});

describe('applyOperation', () => {
  it('adds a task without touching the input', () => {
    const before = emptyData();
    const created = applyOperation(before, {
      type: 'add-task',
      task: task('t1', '钱包改版', '2026-11-02', '2026-11-06'),
    });
    expect(before.tasks).toEqual([]);
    expect(created.tasks.map((item) => item.name)).toEqual(['钱包改版']);
    expect(created.tasks[0]).toMatchObject({ start: '2026-11-02', end: '2026-11-06', color: 'blue' });
  });

  it('treats a replayed add as the same item (write retries must not duplicate)', () => {
    const once = applyOperation(emptyData(), { type: 'add-task', task: task('t1', '钱包改版') });
    const twice = applyOperation(once, { type: 'add-task', task: task('t1', '钱包改版（改名）') });
    expect(twice.tasks).toHaveLength(1);
    expect(twice.tasks[0]!.name).toBe('钱包改版（改名）');
  });

  it('reschedules, renames, recolors and re-notes a task by id', () => {
    const data = dataWith([task('t1', '联调', '2026-11-02', '2026-11-06')]);
    const moved = applyOperation(data, { type: 'update-task', taskId: 't1', start: '2026-11-09', end: '2026-11-13' });
    expect(moved.tasks[0]).toMatchObject({ start: '2026-11-09', end: '2026-11-13' });
    const edited = applyOperation(moved, { type: 'update-task', taskId: 't1', name: '联调（二期）', color: 'rose' });
    expect(edited.tasks[0]).toMatchObject({ name: '联调（二期）', color: 'rose', start: '2026-11-09' });
    const noted = applyOperation(edited, { type: 'update-task', taskId: 't1', note: '## 验收\n- 走查通过' });
    expect(noted.tasks[0]!.note).toContain('走查通过');
    expect(applyOperation(noted, { type: 'update-task', taskId: 't1', note: '' }).tasks[0]!.note).toBe('');
  });

  it('rejects impossible ranges and bad colors with a message a model can act on', () => {
    const data = dataWith([task('t1', '开发', '2026-11-02', '2026-11-06')]);
    expect(() => applyOperation(data, { type: 'update-task', taskId: 't1', start: '2026-11-10' })).toThrow(
      '结束日期不能早于开始日期',
    );
    expect(() =>
      applyOperation(data, { type: 'add-task', task: task('t2', '测试', '2026-13-01', '2026-13-02') }),
    ).toThrow('开始日期不是有效日期');
    expect(() => applyOperation(data, { type: 'update-task', taskId: 't1', name: '   ' })).toThrow('任务名称不能为空');
    expect(() =>
      applyOperation(data, { type: 'update-task', taskId: 't1', color: 'pink' as ScheduleTask['color'] }),
    ).toThrow('颜色只能是');
  });

  it('tells the caller when the id it holds is gone', () => {
    expect(() =>
      applyOperation(dataWith([task('t1', 'A')]), { type: 'update-task', taskId: 'gone', name: 'X' }),
    ).toThrow('这个任务已经不在了');
    expect(() => applyOperation(dataWith([task('t1', 'A')]), { type: 'delete-task', taskId: 'gone' })).toThrow(
      '这个任务已经不在了',
    );
  });

  it('deletes one task at a time', () => {
    const data = dataWith([task('t1', 'A'), task('t2', 'B')]);
    expect(applyOperation(data, { type: 'delete-task', taskId: 't1' }).tasks.map((item) => item.id)).toEqual(['t2']);
  });

  it('caps the number of tasks', () => {
    const full = dataWith(Array.from({ length: MAX_TASKS }, (_, index) => task(`t${index}`, `T${index}`)));
    expect(() => applyOperation(full, { type: 'add-task', task: task('extra', '新') })).toThrow(
      `任务最多 ${MAX_TASKS} 条`,
    );
  });

  it('updates the document title and scale', () => {
    const titled = applyOperation(emptyData(), { type: 'update-title', title: '  2026 下半年  ' });
    expect(titled.title).toBe('2026 下半年');
    expect(applyOperation(titled, { type: 'update-title', title: '   ' }).title).toBe(DEFAULT_TITLE);
    expect(applyOperation(titled, { type: 'update-scale', scale: 'month' }).scale).toBe('month');
    expect(applyOperation(titled, { type: 'update-scale', scale: 'year' as never }).scale).toBe('day');
  });

  it('keeps the zoom factor between 0.35 and 6', () => {
    expect(emptyData().zoom).toBe(1);
    expect(applyOperation(emptyData(), { type: 'update-zoom', zoom: 2.5 }).zoom).toBe(2.5);
    expect(applyOperation(emptyData(), { type: 'update-zoom', zoom: 99 }).zoom).toBe(6);
    expect(applyOperation(emptyData(), { type: 'update-zoom', zoom: 0.01 }).zoom).toBe(0.35);
    expect(applyOperation(emptyData(), { type: 'update-zoom', zoom: Number.NaN }).zoom).toBe(1);
  });

  it('replaces everything for import and clears only the tasks', () => {
    const data = dataWith([task('t1', 'A')]);
    const replaced = applyOperation(data, {
      type: 'replace',
      title: '导入的排期',
      scale: 'week',
      tasks: [task('t9', '新任务')],
    });
    expect(replaced).toMatchObject({ title: '导入的排期', scale: 'week' });
    expect(replaced.tasks.map((item) => item.id)).toEqual(['t9']);
    expect(applyOperation(replaced, { type: 'clear-tasks' }).tasks).toEqual([]);
    expect(applyOperation(replaced, { type: 'clear-tasks' }).title).toBe('导入的排期');
  });
});

describe('import / export / sample', () => {
  it('round-trips its own export', () => {
    const data = {
      ...dataWith([task('t1', 'A', '2026-10-01', '2026-10-02', { color: 'rose', note: '备注' })]),
      title: '我的项目',
      scale: 'week' as const,
    };
    const imported = parseImport(JSON.parse(JSON.stringify(exportDocument(data))));
    expect(imported).toMatchObject({ title: '我的项目', scale: 'week' });
    expect(imported.tasks[0]).toMatchObject({ id: 't1', color: 'rose', note: '备注' });
    // 缩放是这台设备的视图偏好，不跟导出文件走
    expect(exportDocument({ ...data, zoom: 2 })).not.toHaveProperty('zoom');
  });

  it('rejects an import with no valid tasks', () => {
    expect(() => parseImport({ tasks: [] })).toThrow('任务列表为空');
    expect(() => parseImport({ plans: [{ id: 'p', name: 'A' }] })).toThrow('任务列表为空');
  });

  it('builds a sample around this week’s Monday', () => {
    const data = sampleData('2026-10-29');
    expect(data.tasks).toHaveLength(9);
    expect(data.tasks[0]).toMatchObject({ name: '调研与竞品分析', start: '2026-10-26', end: '2026-10-30' });
    expect(new Set(data.tasks.map((item) => item.color)).size).toBeGreaterThan(4);
  });
});

describe('formatSchedule / taskHint', () => {
  it('lists tasks with ids, colors and per-task hints so the model can edit straight away', () => {
    const text = formatSchedule(
      dataWith([
        task('t1', '开发', '2026-10-20', '2026-10-24', { color: 'blue', note: '依赖设计稿' }),
        task('t2', '测试', '2026-10-30', '2026-11-03', { color: 'amber' }),
      ]),
      TODAY,
    );
    expect(text).toContain(`今天 ${TODAY}`);
    expect(text).toContain('排期「我的排期」 · 2 个任务');
    expect(text).toContain('1. [t1] 开发｜2026-10-20 → 2026-10-24｜5 天｜已结束 5 天｜blue');
    expect(text).toContain('备注：依赖设计稿');
    expect(text).toContain('2. [t2] 测试｜2026-10-30 → 2026-11-03｜5 天｜明天开始｜amber');
  });

  it('says the schedule is empty instead of printing nothing', () => {
    expect(formatSchedule(emptyData(), TODAY)).toBe(
      `今天 ${TODAY}\n排期「${DEFAULT_TITLE}」是空的（还没有任何任务）。`,
    );
  });

  it('describes a running task by day', () => {
    expect(taskHint({ start: '2026-10-01', end: '2026-10-03' }, '2026-10-02')).toBe('进行中，第 2/3 天');
  });
});
