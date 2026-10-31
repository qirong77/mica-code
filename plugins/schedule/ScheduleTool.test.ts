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
    await expect(tool.execute({ operation: 'list' })).resolves.toContain('还没有任何任务');
  });

  it('adds a task and defaults its end date to the start', async () => {
    const created = await tool.execute({ operation: 'add_task', name: '钱包改版', start: '2026-11-02' });
    const taskId = data().tasks[0]!.id;
    expect(created).toContain(`已添加任务「钱包改版」：2026-11-02`);
    expect(data().tasks[0]).toMatchObject({
      id: taskId,
      name: '钱包改版',
      start: '2026-11-02',
      end: '2026-11-02',
      color: 'blue',
      note: '',
    });
    expect(data().summary).toBe('1 个任务');
  });

  it('adds a full range with an explicit color and Markdown note', async () => {
    await tool.execute({
      operation: 'add_task',
      name: '联调',
      start: '2026-11-02',
      end: '2026-11-06',
      color: 'rose',
      note: '## 前置\n- 后端接口就绪',
    });
    await tool.execute({ operation: 'add_task', name: '上线', start: '2026-11-09' });
    const [first, second] = data().tasks;
    expect(first).toMatchObject({ name: '联调', start: '2026-11-02', end: '2026-11-06', color: 'rose' });
    expect(first!.note).toContain('后端接口就绪');
    // 没指定颜色时顺着色板换，和页面里新建任务的默认行为一致
    expect(second).toMatchObject({ name: '上线', color: 'violet' });
  });

  it('reschedules, recolors and renames a task by id', async () => {
    await tool.execute({ operation: 'add_task', name: '联调', start: '2026-11-02', end: '2026-11-06' });
    const taskId = data().tasks[0]!.id;

    const moved = await tool.execute({
      operation: 'update_task',
      task_id: taskId,
      start: '2026-11-09',
      end: '2026-11-13',
    });
    expect(moved).toContain('「联调」改成 2026-11-09 → 2026-11-13（5 天）');

    const renamed = await tool.execute({ operation: 'update_task', task_id: taskId, name: '联调（二期）' });
    expect(renamed).toContain('任务已改名为「联调（二期）」');

    const recolored = await tool.execute({ operation: 'update_task', task_id: taskId, color: 'emerald' });
    expect(recolored).toContain('「联调（二期）」的颜色改成绿色');

    const noted = await tool.execute({ operation: 'update_task', task_id: taskId, note: '走查通过' });
    expect(noted).toContain('已更新任务「联调（二期）」的备注');
    expect(await tool.execute({ operation: 'update_task', task_id: taskId, note: '' })).toContain('已清空任务');
    expect(data().tasks[0]).toMatchObject({
      name: '联调（二期）',
      start: '2026-11-09',
      end: '2026-11-13',
      color: 'emerald',
      note: '',
    });
  });

  it('deletes a single task', async () => {
    await tool.execute({ operation: 'add_task', name: '开发', start: '2026-11-02' });
    await tool.execute({ operation: 'add_task', name: '测试', start: '2026-11-03' });
    const [first] = data().tasks;
    expect(await tool.execute({ operation: 'delete_task', task_id: first!.id })).toContain('已删除任务「开发」');
    expect(data().tasks.map((task) => task.name)).toEqual(['测试']);
  });

  it('rejects an unknown operation and missing required fields', async () => {
    await expect(tool.execute({ operation: 'explode' })).rejects.toThrow('operation 只能是');
    await expect(tool.execute({ operation: 'update_task', name: '开发' })).rejects.toThrow('缺少 task_id');
    await expect(tool.execute({ operation: 'add_task' })).rejects.toThrow('缺少 name');
    await expect(tool.execute({ operation: 'add_task', name: '开发' })).rejects.toThrow('缺少 start');
  });

  it('rejects a bad date, a backwards range or an unknown color without touching the file', async () => {
    await expect(
      tool.execute({ operation: 'add_task', name: '开发', start: '2026-11-09', end: '2026-11-02' }),
    ).rejects.toThrow('结束日期不能早于开始日期');
    await expect(tool.execute({ operation: 'add_task', name: '开发', start: '11 月 9 日' })).rejects.toThrow(
      '要 YYYY-MM-DD',
    );
    await expect(
      tool.execute({ operation: 'add_task', name: '开发', start: '2026-11-09', color: 'pink' as never }),
    ).rejects.toThrow('color 只能是');
    expect(data().tasks).toEqual([]);
  });

  it('keeps the schedule usable after the tool-level failure path (executeTimed)', async () => {
    const result = await tool.executeTimed({ operation: 'delete_task', task_id: 'gone' });
    expect(String(result)).toContain('这个任务已经不在了');
  });
});
