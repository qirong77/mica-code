import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScheduleTool } from './ScheduleTool.js';
import { readScheduleData, SCHEDULE_DATA_FILE } from './store.js';

let dir = '';
let tool: ScheduleTool;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mica-schedule-tool-'));
  tool = new ScheduleTool(join(dir, SCHEDULE_DATA_FILE));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const data = () => readScheduleData(join(dir, SCHEDULE_DATA_FILE));

describe('schedule tool', () => {
  it('says the schedule is empty before anything is written', async () => {
    await expect(tool.execute({ operation: 'list' })).resolves.toContain('排期是空的');
  });

  it('creates a plan and adds a stage to it', async () => {
    const created = await tool.execute({ operation: 'add_plan', name: '钱包改版', note: '双十一前上线' });
    const planId = data().plans[0]!.id;
    expect(created).toContain(`钱包改版（${planId}）`);
    expect(created).toContain('双十一前上线');

    await tool.execute({
      operation: 'add_stage',
      plan_id: planId,
      name: '开发',
      start: '2026-11-02',
      end: '2026-11-06',
    });
    await tool.execute({ operation: 'add_stage', plan_id: planId, name: '测试', start: '2026-11-07' });
    const saved = data();
    expect(saved.plans[0]!.stages).toHaveLength(2);
    // 只给开始日 = 一天的事
    expect(saved.plans[0]!.stages[1]).toMatchObject({ name: '测试', start: '2026-11-07', end: '2026-11-07' });
    expect(saved.summary).toBe('1 个计划 · 2 条阶段');
  });

  it('reschedules and renames a stage by id and reports the new dates', async () => {
    await tool.execute({ operation: 'add_plan', name: 'A' });
    const planId = data().plans[0]!.id;
    await tool.execute({
      operation: 'add_stage',
      plan_id: planId,
      name: '联调',
      start: '2026-11-02',
      end: '2026-11-06',
    });
    const stageId = data().plans[0]!.stages[0]!.id;

    const moved = await tool.execute({
      operation: 'update_stage',
      stage_id: stageId,
      start: '2026-11-09',
      end: '2026-11-13',
    });
    expect(moved).toContain('「联调」改成 2026-11-09 → 2026-11-13（5 天）');
    const renamed = await tool.execute({ operation: 'update_stage', stage_id: stageId, name: '联调（二期）' });
    expect(renamed).toContain('阶段已改名为「联调（二期）」');
    expect(data().plans[0]!.stages[0]).toMatchObject({ name: '联调（二期）', start: '2026-11-09', end: '2026-11-13' });
  });

  it('renames a plan and clears its note', async () => {
    await tool.execute({ operation: 'add_plan', name: 'A', note: '旧备注' });
    const planId = data().plans[0]!.id;
    expect(await tool.execute({ operation: 'update_plan', plan_id: planId, name: 'B' })).toContain('计划已改名为「B」');
    expect(await tool.execute({ operation: 'update_plan', plan_id: planId, note: '' })).toContain(
      '已清空计划「B」的备注',
    );
    expect(data().plans[0]).toMatchObject({ name: 'B', note: '' });
  });

  it('deletes a single stage, then the plan with the rest', async () => {
    await tool.execute({ operation: 'add_plan', name: 'A' });
    const planId = data().plans[0]!.id;
    await tool.execute({ operation: 'add_stage', plan_id: planId, name: '开发', start: '2026-11-02' });
    await tool.execute({ operation: 'add_stage', plan_id: planId, name: '测试', start: '2026-11-03' });
    const [first] = data().plans[0]!.stages;
    expect(await tool.execute({ operation: 'delete_stage', stage_id: first!.id })).toContain('已删除阶段「开发」');
    expect(data().plans[0]!.stages.map((stage) => stage.name)).toEqual(['测试']);
    expect(await tool.execute({ operation: 'delete_plan', plan_id: planId })).toContain('（含 1 条阶段）');
    expect(data().plans).toEqual([]);
  });

  it('rejects an unknown operation and missing required fields', async () => {
    await expect(tool.execute({ operation: 'explode' })).rejects.toThrow('operation 只能是');
    await expect(tool.execute({ operation: 'add_stage', name: '开发', start: '2026-11-02' })).rejects.toThrow(
      '缺少 plan_id',
    );
    await expect(tool.execute({ operation: 'add_plan' })).rejects.toThrow('缺少 name');
  });

  it('rejects a bad date or a backwards range without touching the file', async () => {
    await tool.execute({ operation: 'add_plan', name: 'A' });
    const planId = data().plans[0]!.id;
    await expect(
      tool.execute({ operation: 'add_stage', plan_id: planId, name: '开发', start: '2026-11-09', end: '2026-11-02' }),
    ).rejects.toThrow('结束日期不能早于开始日期');
    await expect(
      tool.execute({ operation: 'add_stage', plan_id: planId, name: '开发', start: '11 月 9 日' }),
    ).rejects.toThrow('要 YYYY-MM-DD');
    expect(data().plans[0]!.stages).toEqual([]);
  });

  it('keeps the schedule usable after the tool-level failure path (executeTimed)', async () => {
    const result = await tool.executeTimed({ operation: 'delete_plan', plan_id: 'gone' });
    expect(String(result)).toContain('这个计划已经不在了');
  });
});
