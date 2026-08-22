import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';
import { CompactionNotNeededError } from '@packages/mica-context/index.js';
import {
  LoopController,
  parseDuration,
  DEFAULT_LOOP_INTERVAL_MS,
  parseLoopArgs,
  ToolLoopSetInterval,
  ToolLoopSetTask,
  ToolLoopStatus,
  ToolLoopStop,
  type CommandRuntimeServices,
} from '@packages/mica-builtin-commands/index.js';
import type { MicaTool } from '@packages/mica-tools/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import setupLoop from './loop.js';

describe('parseDuration', () => {
  it('parses unit durations', () => {
    expect(parseDuration('60m')).toBe(3_600_000);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('1.5h')).toBe(5_400_000);
  });

  it('treats a bare number as seconds', () => {
    expect(parseDuration('90')).toBe(90_000);
    expect(parseDuration('0')).toBe(0);
  });

  it('rejects invalid durations', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('m')).toBeNull();
    expect(parseDuration('60x')).toBeNull();
    expect(parseDuration('h1m')).toBeNull();
  });
});

describe('parseLoopArgs', () => {
  it('returns status for empty input', () => {
    expect(parseLoopArgs('')).toEqual({ kind: 'status' });
  });

  it('returns stop for stop/off/cancel', () => {
    expect(parseLoopArgs('stop')).toEqual({ kind: 'stop' });
    expect(parseLoopArgs('off')).toEqual({ kind: 'stop' });
    expect(parseLoopArgs('cancel')).toEqual({ kind: 'stop' });
    expect(parseLoopArgs('STATUS')).toEqual({ kind: 'status' });
  });

  it('parses interval and task', () => {
    const result = parseLoopArgs('60m 推送一个 BBC 的新闻');
    expect(result).toMatchObject({ kind: 'start', intervalMs: 3_600_000, intervalLabel: '1 小时', task: '推送一个 BBC 的新闻' });
  });

  it('rejects a missing task', () => {
    expect(parseLoopArgs('60m')).toMatchObject({ kind: 'error' });
  });

  it('uses the default interval when no interval is given', () => {
    const result = parseLoopArgs('推送一个 BBC 的新闻');
    expect(result).toMatchObject({
      kind: 'start',
      intervalMs: DEFAULT_LOOP_INTERVAL_MS,
      intervalLabel: '30 分钟',
      task: '推送一个 BBC 的新闻',
    });
  });

  it('treats the whole input as the task when the first token is not a duration', () => {
    const result = parseLoopArgs('abc 推送新闻');
    expect(result).toMatchObject({
      kind: 'start',
      intervalMs: DEFAULT_LOOP_INTERVAL_MS,
      task: 'abc 推送新闻',
    });
  });

  it('rejects an interval shorter than the minimum', () => {
    expect(parseLoopArgs('5s 推送新闻')).toMatchObject({ kind: 'error' });
  });
});

describe('LoopController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires immediately on start, reschedules on interval, stops on stop()', () => {
    const controller = new LoopController();
    const submit = vi.fn(async () => undefined);
    controller.start({
      intervalMs: 60_000,
      intervalLabel: '1 分钟',
      task: '推送新闻',
      ownerSessionId: 's1',
      canFire: () => true,
      submit,
    });

    expect(controller.active?.fireCount).toBe(0);
    expect(controller.buildSystemPromptSuffix()).toContain('定时循环任务');
    expect(controller.buildSystemPromptSuffix()).toContain('推送新闻');

    controller.fireNow();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(controller.active?.fireCount).toBe(1);
    expect(submit).toHaveBeenCalledWith('推送新闻', expect.stringContaining('定时任务第 1 次'));

    vi.advanceTimersByTime(60_000);
    expect(submit).toHaveBeenCalledTimes(2);

    controller.stop();
    vi.advanceTimersByTime(120_000);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(controller.active).toBeNull();
    expect(controller.buildSystemPromptSuffix()).toBeNull();
  });

  it('skips a fire while busy and continues on the next interval', () => {
    const controller = new LoopController();
    let busy = true;
    const submit = vi.fn(async () => undefined);
    controller.start({
      intervalMs: 60_000,
      intervalLabel: '1 分钟',
      task: 't',
      ownerSessionId: 's1',
      canFire: () => !busy,
      submit,
    });
    controller.fireNow(); // 立即执行不受 busy 影响
    expect(submit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_000); // busy -> skip
    expect(submit).toHaveBeenCalledTimes(1);

    busy = false;
    vi.advanceTimersByTime(60_000); // idle -> fire
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('restart replaces the previous loop', () => {
    const controller = new LoopController();
    const submit = vi.fn(async () => undefined);
    controller.start({
      intervalMs: 60_000,
      intervalLabel: '1 分钟',
      task: '旧任务',
      ownerSessionId: 's1',
      canFire: () => true,
      submit,
    });
    controller.fireNow();
    controller.start({
      intervalMs: 3_600_000,
      intervalLabel: '1 小时',
      task: '新任务',
      ownerSessionId: 's1',
      canFire: () => true,
      submit,
    });
    expect(controller.active?.fireCount).toBe(0);
    expect(controller.buildSystemPromptSuffix()).toContain('新任务');
    expect(controller.buildSystemPromptSuffix()).not.toContain('每次任务内容：旧任务');
  });
});

describe('loop plugin', () => {
  it('registers /loop and injects loop guidance into the system prompt while active', async () => {
    const { hooks, registered, notices, submitted } = createHarness();
    const command = registered.get('loop')!;
    expect(command).toBeDefined();

    await command.action('60m 推送一个 BBC 的新闻');
    await flush();

    expect(notices.some((n) => n.includes('loop 已启动'))).toBe(true);
    expect(submitted).toHaveLength(1); // 启动即执行第一次

    const built = hooks.pipelineSync('system-prompt:build', { runtime: {}, prompt: 'BASE' });
    expect(built.prompt).toContain('定时循环任务');
    expect(built.prompt).toContain('推送一个 BBC 的新闻');
    expect(built.prompt.startsWith('BASE')).toBe(true);
  });

  it('stops the loop and removes the guidance', async () => {
    const { hooks, registered, notices } = createHarness();
    const command = registered.get('loop')!;

    await command.action('60m 推送新闻');
    await command.action('stop');

    expect(notices.some((n) => n.includes('loop 已停止'))).toBe(true);
    const built = hooks.pipelineSync('system-prompt:build', { runtime: {}, prompt: 'BASE' });
    expect(built.prompt).toBe('BASE');
  });

  it('shows status and error notices', async () => {
    const { registered, notices } = createHarness();
    const command = registered.get('loop')!;

    await command.action('');
    expect(notices.some((n) => n.includes('当前没有运行的定时循环任务'))).toBe(true);

    await command.action('60m');
    expect(notices.some((n) => n.includes('缺少任务描述'))).toBe(true);
  });

  it('registers the loop adjustment tools for the primary agent', () => {
    const { registeredTools } = createHarness();
    expect(registeredTools.map((t) => t.name).sort()).toEqual([
      'loop_set_interval',
      'loop_set_task',
      'loop_status',
      'loop_stop',
    ]);
  });

  it('pushes loop status to the UI store and clears it on stop', async () => {
    micaUi.panels.setLoopStatus(null);
    const { registered } = createHarness();
    const command = registered.get('loop')!;

    expect(micaUi.panels.loopStatus.get()).toBeNull();
    await command.action('60m 推送一个 BBC 的新闻');

    const status = micaUi.panels.loopStatus.get();
    expect(status).not.toBeNull();
    expect(status?.intervalLabel).toBe('1 小时');
    expect(status?.task).toBe('推送一个 BBC 的新闻');
    expect(status?.fireCount).toBe(1);
    expect(status?.nextFireAt).toBeGreaterThan(Date.now());

    await command.action('stop');
    expect(micaUi.panels.loopStatus.get()).toBeNull();
  });

  it('compacts the session before every loop run', async () => {
    const { registered, services } = createHarness();
    const command = registered.get('loop')!;

    await command.action('60m 推送新闻');
    await command.action('60m 推送新闻'); // 重启后立即执行第一次
    await flush();

    expect(services.compact).toHaveBeenCalledTimes(2);
    expect(services.submitAgentSessionInput).toHaveBeenCalledTimes(2);
    expect(services.compact).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      's1',
      expect.objectContaining({ pruneOnly: true }),
    );
  });

  it('still submits the task when compaction is not needed', async () => {
    const { registered, services, notices } = createHarness();
    (services.compact as ReturnType<typeof vi.fn>).mockRejectedValue(new CompactionNotNeededError());
    const command = registered.get('loop')!;

    await command.action('60m 推送新闻');
    await flush();

    expect(services.submitAgentSessionInput).toHaveBeenCalledTimes(1);
    expect(notices.some((n) => n.includes('压缩失败'))).toBe(false);
  });
});

type RegisteredCommand = { name: string; action(args?: string): Promise<unknown> };
type RegisteredTool = { name: string };

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createHarness() {
  const hooks = new micaPlugin.HookRegistry();
  const published: unknown[] = [];
  const notices: string[] = [];
  const submitted: Array<{ text: string; options?: unknown }> = [];
  const registeredTools: RegisteredTool[] = [];
  const services = {
    getCurrentAgentSessionId: () => 's1',
    isAgentBusy: () => false,
    compact: vi.fn(async () => ({})),
    submitAgentSessionInput: vi.fn(async (_id: string, text: string, options?: unknown) => {
      submitted.push({ text, options });
      return { ok: true };
    }),
    showNotice: vi.fn((text: string) => notices.push(text)),
  };
  const registered = new Map<string, RegisteredCommand>();
  const ctx = {
    pluginId: 'builtin.command.loop',
    hooks,
    services: {
      get: (token: unknown) =>
        token === commandHostToken
          ? {
              agent: { config: { provider: { contextWindowSize: 128_000 } } },
              sessionController: {},
              services,
              registerCommand: (_ctx: PluginContext, command: RegisteredCommand) => registered.set(command.name, command),
            }
          : undefined,
    },
    tools: {
      register: (tool: MicaTool) => {
        registeredTools.push({ name: tool.name });
        return { dispose: () => undefined };
      },
    },
    events: { publish: vi.fn((event: unknown) => published.push(event)) },
    onDispose: vi.fn(),
  } as unknown as PluginContext;

  setupLoop(ctx);
  return { hooks, registered, services, notices, submitted, published, registeredTools };
}

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
    expect(controller.buildSystemPromptSuffix()).not.toContain('每次任务内容：旧任务');
  });

  it('updateInterval/updateTask return null when not running', () => {
    const controller = new LoopController();
    expect(controller.updateInterval(60_000)).toBeNull();
    expect(controller.updateTask('任务')).toBeNull();
  });
});
