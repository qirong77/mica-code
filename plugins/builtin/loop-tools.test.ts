import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LoopController,
  ToolLoopSetInterval,
  ToolLoopSetTask,
  ToolLoopStatus,
  ToolLoopStop,
  type CommandRuntimeServices,
} from '@packages/mica-builtin-commands/index.js';

function makeDeps(overrides: { sessionId?: string } = {}) {
  const notices: string[] = [];
  const controller = new LoopController();
  const services = {
    getCurrentAgentSessionId: () => overrides.sessionId ?? 's1',
    showNotice: (text: string) => notices.push(text),
  } as unknown as CommandRuntimeServices;
  return { controller, services, notices };
}

function startLoop(controller: LoopController, task = '推送新闻') {
  controller.start({
    intervalMs: 60_000,
    intervalLabel: '1 分钟',
    task,
    ownerSessionId: 's1',
    canFire: () => true,
    submit: vi.fn(async () => undefined),
  });
}

describe('loop tools', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loop_status reports the running loop and the absence of one', async () => {
    const deps = makeDeps();
    expect(await new ToolLoopStatus(deps).execute({})).toContain('当前没有运行的定时循环任务');

    startLoop(deps.controller);
    const output = await new ToolLoopStatus(deps).execute({});
    expect(output).toContain('每 1 分钟');
    expect(output).toContain('推送新闻');
    expect(output).toContain('已执行 0 次');
  });

  it('loop_set_interval updates the interval and reschedules', async () => {
    const deps = makeDeps();
    startLoop(deps.controller);

    const output = await new ToolLoopSetInterval(deps).execute({ interval: '30m' });
    expect(output).toContain('每 30 分钟');
    expect(deps.controller.active?.intervalMs).toBe(1_800_000);
    expect(deps.notices.some((n) => n.includes('间隔已调整为每 30 分钟'))).toBe(true);

    // 重新计时：旧的 60s 不再触发，新的 30m 触发
    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(1_740_000);
    expect(deps.controller.active?.fireCount).toBe(1);
  });

  it('loop_set_interval rejects invalid or too-short intervals', async () => {
    const deps = makeDeps();
    startLoop(deps.controller);

    const invalid = await new ToolLoopSetInterval(deps).execute({ interval: 'abc' });
    expect(invalid).toContain('无法解析循环间隔');

    const tooShort = await new ToolLoopSetInterval(deps).execute({ interval: '5s' });
    expect(tooShort).toContain('最少 10 秒');
    expect(deps.controller.active?.intervalMs).toBe(60_000);
  });

  it('loop_set_task updates the task content', async () => {
    const deps = makeDeps();
    startLoop(deps.controller);

    const output = await new ToolLoopSetTask(deps).execute({ task: '  跟踪仓库提交  ' });
    expect(output).toContain('跟踪仓库提交');
    expect(deps.controller.active?.task).toBe('跟踪仓库提交');
    expect(deps.notices.some((n) => n.includes('任务已更新'))).toBe(true);

    const empty = await new ToolLoopSetTask(deps).execute({ task: '   ' });
    expect(empty).toContain('任务内容不能为空');
  });

  it('loop_stop stops the loop', async () => {
    const deps = makeDeps();
    startLoop(deps.controller);

    const output = await new ToolLoopStop(deps).execute({});
    expect(output).toContain('已停止');
    expect(deps.controller.active).toBeNull();
    expect(deps.notices.some((n) => n.includes('loop 已停止'))).toBe(true);

    const again = await new ToolLoopStop(deps).execute({});
    expect(again).toContain('当前没有运行的定时循环任务');
  });

  it('rejects changes from a non-owner session', async () => {
    const deps = makeDeps({ sessionId: 'other-session' });
    startLoop(deps.controller);

    const output = await new ToolLoopSetInterval(deps).execute({ interval: '30m' });
    expect(output).toContain('不属于这个会话');
    expect(deps.controller.active?.intervalMs).toBe(60_000);
  });

  it('rejects subagent calls', async () => {
    const deps = makeDeps();
    startLoop(deps.controller);

    const output = await new ToolLoopStop(deps).execute({}, { context: { taskId: 'sub-1' } });
    expect(output).toContain('只能在主会话中使用');
    expect(deps.controller.active).not.toBeNull();
  });
});

describe('LoopController interval/task updates', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('updateInterval changes the interval and reschedules from the update time', () => {
    const controller = new LoopController();
    const submit = vi.fn(async () => undefined);
    controller.start({
      intervalMs: 60_000,
      intervalLabel: '1 分钟',
      task: 't',
      ownerSessionId: 's1',
      canFire: () => true,
      submit,
    });
    controller.fireNow();
    expect(submit).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 30_000);
    const updated = controller.updateInterval(3_600_000);
    expect(updated?.intervalMs).toBe(3_600_000);
    expect(updated?.intervalLabel).toBe('1 小时');
    expect(controller.buildSystemPromptSuffix()).toContain('每 1 小时');

    // 旧的 60s 间隔不应触发
    vi.advanceTimersByTime(30_000);
    expect(submit).toHaveBeenCalledTimes(1);
    // 新的 1h 间隔触发
    vi.advanceTimersByTime(3_600_000);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('updateTask changes the task content in state and guidance', () => {
    const controller = new LoopController();
    controller.start({
      intervalMs: 60_000,
      intervalLabel: '1 分钟',
      task: '旧任务',
      ownerSessionId: 's1',
      canFire: () => true,
      submit: vi.fn(async () => undefined),
    });
    const updated = controller.updateTask('新任务');
    expect(updated?.task).toBe('新任务');
    expect(controller.buildSystemPromptSuffix()).toContain('新任务');
    expect(controller.buildSystemPromptSuffix()).not.toContain('旧任务');
  });

  it('updateInterval/updateTask return null when not running', () => {
    const controller = new LoopController();
    expect(controller.updateInterval(60_000)).toBeNull();
    expect(controller.updateTask('任务')).toBeNull();
  });
});
